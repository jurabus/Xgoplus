-- =====================================================================
-- XGo Plus — 006 usage limits, customer scan history, complaints,
--               discount filter for search
-- Idempotent. Run after 005.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Usage limits on providers (set by admin or by the provider)
--    limit_count/limit_period: max successful uses per member per calendar
--    day/week/month/year (Cairo time). allowed_days: 0=Sun … 6=Sat.
-- ---------------------------------------------------------------------
alter table public.providers add column if not exists limit_count smallint;
alter table public.providers add column if not exists limit_period text;
alter table public.providers add column if not exists allowed_days smallint[];
alter table public.providers drop constraint if exists providers_limit_check;
alter table public.providers add constraint providers_limit_check check (
  (limit_count is null and limit_period is null)
  or (limit_count is not null and limit_period is not null
      and limit_count between 1 and 100 and limit_period in ('day', 'week', 'month', 'year')));
alter table public.providers drop constraint if exists providers_days_check;
alter table public.providers add constraint providers_days_check check (
  allowed_days is null
  or (cardinality(allowed_days) between 1 and 7 and allowed_days <@ array[0,1,2,3,4,5,6]::smallint[]));
grant select (limit_count, limit_period, allowed_days) on public.providers to anon, authenticated;
grant update (limit_count, limit_period, allowed_days) on public.providers to authenticated;

-- normalize days: sorted, unique; all 7 days == no restriction
create or replace function private.providers_days_norm() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.allowed_days is not null then
    new.allowed_days := (select array_agg(distinct d order by d) from unnest(new.allowed_days) d);
    if cardinality(new.allowed_days) = 7 then new.allowed_days := null; end if;
  end if;
  return new;
end $$;
drop trigger if exists providers_days_norm on public.providers;
create trigger providers_days_norm before insert or update of allowed_days on public.providers
  for each row execute function private.providers_days_norm();

create or replace function public.admin_update_provider(p_id uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_admin();
  update public.providers set
    name = case when p_patch ? 'name' then p_patch->>'name' else name end,
    discount_percent = case when p_patch ? 'discount_percent' then (p_patch->>'discount_percent')::numeric else discount_percent end,
    notes = case when p_patch ? 'notes' then coalesce(p_patch->>'notes', '') else notes end,
    image_path = case when p_patch ? 'image_path' then p_patch->>'image_path' else image_path end,
    is_active = case when p_patch ? 'is_active' then (p_patch->>'is_active')::boolean else is_active end,
    sort_order = case when p_patch ? 'sort_order' then (p_patch->>'sort_order')::int else sort_order end,
    category_id = case when p_patch ? 'category_id' then nullif(p_patch->>'category_id', '')::uuid else category_id end,
    limit_count = case when p_patch ? 'limit_count' then (p_patch->>'limit_count')::smallint else limit_count end,
    limit_period = case when p_patch ? 'limit_period' then nullif(p_patch->>'limit_period', '') else limit_period end,
    allowed_days = case when p_patch ? 'allowed_days' then
      (case when jsonb_typeof(p_patch->'allowed_days') = 'array'
            then (select array_agg(x::smallint) from jsonb_array_elements_text(p_patch->'allowed_days') x) end)
      else allowed_days end
  where id = p_id;
  if not found then raise exception 'not_found'; end if;
end $$;
revoke all on function public.admin_update_provider(uuid, jsonb) from public, anon;
grant execute on function public.admin_update_provider(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 2) Scans: which ones count as a "use", new results
-- ---------------------------------------------------------------------
alter table public.scans add column if not exists counted boolean not null default false;
update public.scans set counted = true where result = 'active' and counted = false
  and not exists (select 1 from pg_class where relname = 'scans_member_uses'); -- first run only
alter table public.scans drop constraint if exists scans_result_check;
alter table public.scans add constraint scans_result_check
  check (result in ('active', 'expired', 'invalid', 'stale', 'limit_reached', 'not_today'));
create index if not exists scans_member_uses on public.scans (member_id, provider_id, created_at desc) where counted;
create index if not exists scans_member_time on public.scans (member_id, created_at desc);

-- Usage state of one member at one provider (Cairo calendar periods)
create or replace function private.usage_state(p_uid uuid, p_pid uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_p record;
  v_local timestamp := now() at time zone 'Africa/Cairo';
  v_start timestamptz; v_reset timestamptz; v_used int := 0; v_today boolean;
begin
  select limit_count, limit_period, allowed_days into v_p from public.providers where id = p_pid;
  v_today := v_p.allowed_days is null or extract(dow from v_local)::smallint = any (v_p.allowed_days);
  if v_p.limit_count is not null then
    v_start := date_trunc(v_p.limit_period, v_local) at time zone 'Africa/Cairo';
    v_reset := (date_trunc(v_p.limit_period, v_local) + ('1 ' || v_p.limit_period)::interval) at time zone 'Africa/Cairo';
    select count(*) into v_used from public.scans s
     where s.member_id = p_uid and s.provider_id = p_pid and s.counted and s.created_at >= v_start;
  end if;
  return jsonb_build_object(
    'limit_count', v_p.limit_count, 'limit_period', v_p.limit_period, 'allowed_days', to_jsonb(v_p.allowed_days),
    'used', v_used, 'uses_left', case when v_p.limit_count is not null then greatest(v_p.limit_count - v_used, 0) end,
    'resets_at', v_reset, 'valid_today', v_today);
end $$;

create or replace function public.verify_member_qr(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_pid uuid := public.my_provider_id();
  v_provider record;
  v_m text[];
  v_uid uuid;
  v_ts bigint;
  v_now bigint := floor(extract(epoch from now()))::bigint;
  v_profile record;
  v_state jsonb;
  v_usage jsonb;
  v_label text;
  v_result text;
  v_counted boolean := false;
  v_repeat boolean := false;
begin
  if v_pid is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.hit_rate_limit('scan', v_pid::text, 30, 60) then
    raise exception 'rate_limited';
  end if;
  select id, name, discount_percent, notes, limit_count, limit_period, allowed_days into v_provider
    from public.providers where id = v_pid;

  v_m := regexp_match(btrim(coalesce(p_token, '')), '^XG1\.([0-9a-f]{32})\.([0-9]{9,11})\.([0-9a-f]{32})$');
  if v_m is null or private.sign_qr('XG1.' || v_m[1] || '.' || v_m[2]) <> v_m[3] then
    insert into public.scans (provider_id, result) values (v_pid, 'invalid');
    return jsonb_build_object('status', 'invalid');
  end if;
  v_ts := v_m[2]::bigint;
  if v_ts < v_now - 180 or v_ts > v_now + 60 then
    insert into public.scans (provider_id, result) values (v_pid, 'stale');
    return jsonb_build_object('status', 'stale');
  end if;
  v_uid := v_m[1]::uuid;
  select id, first_name, last_name into v_profile from public.profiles where id = v_uid;
  if v_profile.id is null then
    insert into public.scans (provider_id, result) values (v_pid, 'invalid');
    return jsonb_build_object('status', 'invalid');
  end if;

  -- one decision at a time per (provider, member): no double-spend by parallel scans
  perform pg_advisory_xact_lock(hashtextextended(v_pid::text || v_uid::text, 0));

  v_label := v_profile.first_name || ' ' || left(v_profile.last_name, 1) || '.';
  v_state := private.membership_state(v_uid);
  v_usage := private.usage_state(v_uid, v_pid);
  if v_state->>'status' <> 'active' then
    v_result := 'expired';
  elsif not (v_usage->>'valid_today')::boolean then
    v_result := 'not_today';
  elsif exists (select 1 from public.scans s where s.provider_id = v_pid and s.member_id = v_uid and s.counted
                  and s.created_at > now() - interval '15 minutes') then
    v_result := 'active'; v_repeat := true;          -- same checkout re-scanned: don't count twice
  elsif v_provider.limit_count is not null and (v_usage->>'uses_left')::int <= 0 then
    v_result := 'limit_reached';
  else
    v_result := 'active'; v_counted := true;
  end if;

  insert into public.scans (provider_id, member_id, member_label, result, discount_percent, counted)
  values (v_pid, v_uid, v_label, v_result,
          case when v_result = 'active' then v_provider.discount_percent end, v_counted);
  if v_counted then v_usage := private.usage_state(v_uid, v_pid); end if;

  return jsonb_build_object(
    'status', v_result,
    'member_name', v_label,
    'expires_at', v_state->'expires_at',
    'discount_percent', case when v_result = 'active' then v_provider.discount_percent end,
    'provider_name', v_provider.name,
    'notes', v_provider.notes,
    'repeat', v_repeat,
    'usage', v_usage,
    'checked_at', now()
  );
end $$;
revoke all on function public.verify_member_qr(text) from public, anon;
grant execute on function public.verify_member_qr(text) to authenticated;

-- Customer: my usage at one provider (shown on the provider page)
create or replace function public.my_provider_usage(p_provider uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (select 1 from public.profiles where id = auth.uid()) then return null; end if;
  if not exists (select 1 from public.providers where id = p_provider and is_active) then return null; end if;
  return private.usage_state(auth.uid(), p_provider);
end $$;
revoke all on function public.my_provider_usage(uuid) from public, anon;
grant execute on function public.my_provider_usage(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3) Customer scan history
-- ---------------------------------------------------------------------
create or replace function public.my_scan_history(p_limit int default 20, p_offset int default 0)
returns table (id bigint, created_at timestamptz, provider_id uuid, provider_name text, provider_image text,
               result text, discount_percent numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
    select s.id, s.created_at, s.provider_id, p.name, p.image_path, s.result, s.discount_percent
    from public.scans s join public.providers p on p.id = s.provider_id
    where s.member_id = auth.uid()
    order by s.created_at desc, s.id desc
    limit least(greatest(coalesce(p_limit, 20), 1), 50) offset greatest(coalesce(p_offset, 0), 0);
end $$;
revoke all on function public.my_scan_history(int, int) from public, anon;
grant execute on function public.my_scan_history(int, int) to authenticated;

-- ---------------------------------------------------------------------
-- 4) Complaints (customer -> admin). Providers never see them.
-- ---------------------------------------------------------------------
create table if not exists public.complaints (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles(id) on delete cascade,
  provider_id uuid not null references public.providers(id) on delete cascade,
  reason text not null check (length(reason) between 1 and 200),
  details text not null default '' check (length(details) <= 1000),
  status text not null default 'open' check (status in ('open', 'in_review', 'resolved', 'dismissed')),
  admin_note text not null default '' check (length(admin_note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists complaints_member on public.complaints (member_id, created_at desc);
create index if not exists complaints_status on public.complaints (status, created_at desc);
create index if not exists complaints_provider on public.complaints (provider_id, created_at desc);
alter table public.complaints enable row level security;
revoke all on public.complaints from anon, authenticated;   -- RPC access only

create or replace function private.complaint_reasons() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select array_agg(btrim(x)) from public.settings s, jsonb_array_elements_text(s.data->'complaint_reasons') x
      where s.id = 1 and jsonb_typeof(s.data->'complaint_reasons') = 'array' and btrim(x) <> ''),
    array['Refused to apply the discount',
          'Applied a lower discount than shown on the website',
          'Said my membership was not valid',
          'Other'])
$$;

create or replace function public.file_complaint(p_provider uuid, p_reason text, p_details text default '')
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_id uuid; v_details text;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.providers where id = p_provider) then raise exception 'not_found'; end if;
  if not (btrim(coalesce(p_reason, '')) = any (private.complaint_reasons())) then raise exception 'invalid_reason'; end if;
  if not private.hit_rate_limit('complaint', v_uid::text, 5, 86400) then raise exception 'rate_limited'; end if;
  if (select count(*) from public.complaints where member_id = v_uid and provider_id = p_provider
        and created_at > now() - interval '7 days') >= 2 then
    raise exception 'too_many_reports';
  end if;
  v_details := left(btrim(regexp_replace(coalesce(p_details, ''), '[\x01-\x09\x0b-\x1f\x7f<>]', '', 'g')), 1000);
  insert into public.complaints (member_id, provider_id, reason, details)
  values (v_uid, p_provider, btrim(p_reason), v_details) returning id into v_id;
  return v_id;
end $$;

create or replace function public.my_complaints(p_limit int default 20, p_offset int default 0)
returns table (id uuid, created_at timestamptz, provider_id uuid, provider_name text, reason text, details text,
               status text, admin_note text, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
    select c.id, c.created_at, c.provider_id, p.name, c.reason, c.details, c.status, c.admin_note, c.updated_at
    from public.complaints c join public.providers p on p.id = c.provider_id
    where c.member_id = auth.uid()
    order by c.created_at desc, c.id
    limit least(greatest(coalesce(p_limit, 20), 1), 50) offset greatest(coalesce(p_offset, 0), 0);
end $$;

create or replace function public.admin_list_complaints(p_status text default null, p_limit int default 30, p_offset int default 0)
returns table (id uuid, created_at timestamptz, status text, reason text, details text, admin_note text,
               provider_id uuid, provider_name text, member_id uuid, member_name text, member_phone text,
               member_scans_here bigint, total bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_admin();
  return query
    select c.id, c.created_at, c.status, c.reason, c.details, c.admin_note,
           c.provider_id, p.name, c.member_id, m.first_name || ' ' || m.last_name, m.phone,
           (select count(*) from public.scans s where s.member_id = c.member_id and s.provider_id = c.provider_id),
           count(*) over ()
    from public.complaints c
    join public.providers p on p.id = c.provider_id
    join public.profiles m on m.id = c.member_id
    where p_status is null or p_status = '' or c.status = p_status
    order by (c.status = 'open') desc, c.created_at desc, c.id
    limit least(greatest(coalesce(p_limit, 30), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

create or replace function public.admin_update_complaint(p_id uuid, p_status text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_admin();
  if p_status not in ('open', 'in_review', 'resolved', 'dismissed') then raise exception 'invalid_status'; end if;
  update public.complaints set status = p_status, admin_note = left(btrim(coalesce(p_note, '')), 1000), updated_at = now()
  where id = p_id;
  if not found then raise exception 'not_found'; end if;
end $$;

revoke all on function public.file_complaint(uuid, text, text) from public, anon;
revoke all on function public.my_complaints(int, int) from public, anon;
revoke all on function public.admin_list_complaints(text, int, int) from public, anon;
revoke all on function public.admin_update_complaint(uuid, text, text) from public, anon;
grant execute on function public.file_complaint(uuid, text, text) to authenticated;
grant execute on function public.my_complaints(int, int) to authenticated;
grant execute on function public.admin_list_complaints(text, int, int) to authenticated;
grant execute on function public.admin_update_complaint(uuid, text, text) to authenticated;

create or replace function public.admin_stats() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_admin();
  return jsonb_build_object(
    'providers', (select count(*) from public.providers),
    'providers_active', (select count(*) from public.providers where is_active),
    'members', (select count(*) from public.profiles),
    'members_active', (select count(distinct user_id) from public.memberships where starts_at <= now() and expires_at > now()),
    'scans_today', (select count(*) from public.scans where created_at >= date_trunc('day', now())),
    'scans_total', (select count(*) from public.scans),
    'complaints_open', (select count(*) from public.complaints where status in ('open', 'in_review'))
  );
end $$;
revoke all on function public.admin_stats() from public, anon;
grant execute on function public.admin_stats() to authenticated;

-- ---------------------------------------------------------------------
-- 5) Search: optional minimum discount
-- ---------------------------------------------------------------------
drop function if exists public.search_providers(text, uuid, int, int);
drop function if exists public.search_providers(text, uuid, int, int, numeric, uuid);  -- 007's version (re-run safety)
create or replace function public.search_providers(
  p_q text, p_category uuid default null, p_limit int default 20, p_offset int default 0, p_min_discount numeric default null
) returns table (id uuid, name text, image_path text, discount_percent numeric, category_id uuid)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_q text := private.norm(left(coalesce(p_q, ''), 60));
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 20);
begin
  if length(v_q) = 0 then return; end if;
  return query
    select p.id, p.name, p.image_path, p.discount_percent, p.category_id
    from public.providers p
    left join public.categories c on c.id = p.category_id and c.is_active
    where p.is_active
      and (p_category is null or p.category_id = p_category)
      and (p_min_discount is null or p.discount_percent >= p_min_discount)
      and (
        p.search_name like '%' || v_q || '%'
        or extensions.word_similarity(v_q, p.search_name) >= 0.4
        or (length(v_q) >= 3 and c.search_name like v_q || '%')
      )
    order by
      (p.search_name like v_q || '%') desc,
      (p.search_name like '%' || v_q || '%') desc,
      extensions.word_similarity(v_q, p.search_name) desc,
      p.sort_order, p.name, p.id
    limit v_limit offset greatest(coalesce(p_offset, 0), 0);
end $$;
revoke all on function public.search_providers(text, uuid, int, int, numeric) from public;
grant execute on function public.search_providers(text, uuid, int, int, numeric) to anon, authenticated;
create index if not exists providers_discount on public.providers (discount_percent) where is_active;
