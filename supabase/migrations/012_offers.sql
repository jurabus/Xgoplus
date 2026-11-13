-- =====================================================================
-- XGo Plus — 012 multiple discounts per partner ("offers")
-- - discount_rules: admin-only offers on top of the standard discount
--     time     : X% between two times (Cairo time), optional weekdays
--     first    : X% on a member's first visit to this partner
--     service  : X% on a named service (shown as a list at checkout)
-- - providers.max_percent = best active discount (cards show "Up to X%",
--   top deals and the discount filter use it)
-- - verify_member_qr picks the discount that applies right now and returns
--   the service list; scans remember why (standard / time / first)
-- - the standard discount may now be 0 (partner with service offers only)
-- Idempotent. Run after 011.
-- =====================================================================

alter table public.providers drop constraint if exists providers_discount_percent_check;
alter table public.providers add constraint providers_discount_percent_check
  check (discount_percent >= 0 and discount_percent <= 100);

create table if not exists public.discount_rules (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers(id) on delete cascade,
  kind text not null check (kind in ('time', 'first', 'service')),
  title text not null default '' check (length(title) <= 80),
  percent numeric(5,2) not null check (percent > 0 and percent <= 100),
  start_time time,
  end_time time,
  days smallint[] check (days is null or (cardinality(days) between 1 and 7 and days <@ array[0,1,2,3,4,5,6]::smallint[])),
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint discount_rules_time_check check (
    kind <> 'time' or (start_time is not null and end_time is not null and start_time <> end_time)),
  constraint discount_rules_service_title check (kind <> 'service' or length(btrim(title)) > 0)
);
create index if not exists discount_rules_provider on public.discount_rules (provider_id, kind, sort_order);
create unique index if not exists discount_rules_one_first on public.discount_rules (provider_id) where kind = 'first';
alter table public.discount_rules enable row level security;
revoke all on public.discount_rules from anon, authenticated;
grant select (id, provider_id, kind, title, percent, start_time, end_time, days, sort_order, is_active)
  on public.discount_rules to anon, authenticated;
grant insert (provider_id, kind, title, percent, start_time, end_time, days, sort_order, is_active),
      update (kind, title, percent, start_time, end_time, days, sort_order, is_active), delete
  on public.discount_rules to authenticated;

drop policy if exists discount_rules_read on public.discount_rules;
create policy discount_rules_read on public.discount_rules for select to anon, authenticated
  using (public.branch_visible(provider_id, is_active));        -- same rule as branches
drop policy if exists discount_rules_admin_insert on public.discount_rules;
create policy discount_rules_admin_insert on public.discount_rules for insert to authenticated with check ((select public.is_admin()));
drop policy if exists discount_rules_admin_update on public.discount_rules;
create policy discount_rules_admin_update on public.discount_rules for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists discount_rules_admin_delete on public.discount_rules;
create policy discount_rules_admin_delete on public.discount_rules for delete to authenticated using ((select public.is_admin()));

create or replace function private.discount_rules_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.title := private.clean_name(coalesce(new.title, ''));
  if new.kind <> 'time' then new.start_time := null; new.end_time := null; new.days := null; end if;
  if new.days is not null then
    new.days := (select array_agg(distinct d order by d) from unnest(new.days) d);
    if cardinality(new.days) = 7 then new.days := null; end if;
  end if;
  return new;
end $$;
drop trigger if exists discount_rules_guard on public.discount_rules;
create trigger discount_rules_guard before insert or update on public.discount_rules
  for each row execute function private.discount_rules_guard();

-- ---------------------------------------------------------------------
-- providers.max_percent (best active discount)
-- ---------------------------------------------------------------------
alter table public.providers add column if not exists max_percent numeric(5,2) not null default 0;
grant select (max_percent) on public.providers to anon, authenticated;
create index if not exists providers_max_percent on public.providers (max_percent desc) where is_active;

create or replace function private.provider_max_percent(p_id uuid, p_base numeric) returns numeric
language sql stable security definer set search_path = '' as $$
  select greatest(coalesce(p_base, 0),
                  coalesce((select max(r.percent) from public.discount_rules r where r.provider_id = p_id and r.is_active), 0))
$$;

create or replace function private.providers_max_percent() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.max_percent := private.provider_max_percent(new.id, new.discount_percent);
  return new;
end $$;
drop trigger if exists providers_max_percent on public.providers;
create trigger providers_max_percent before insert or update of discount_percent on public.providers
  for each row execute function private.providers_max_percent();

create or replace function private.discount_rules_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  v_ids := array_remove(array[case when tg_op <> 'INSERT' then old.provider_id end,
                              case when tg_op <> 'DELETE' then new.provider_id end], null);
  update public.providers p set max_percent = private.provider_max_percent(p.id, p.discount_percent)
   where p.id = any (v_ids) and p.max_percent is distinct from private.provider_max_percent(p.id, p.discount_percent);
  return null;
end $$;
drop trigger if exists discount_rules_sync on public.discount_rules;
create trigger discount_rules_sync after insert or update or delete on public.discount_rules
  for each row execute function private.discount_rules_sync();

update public.providers p set max_percent = private.provider_max_percent(p.id, p.discount_percent)
 where p.max_percent is distinct from private.provider_max_percent(p.id, p.discount_percent);

-- ---------------------------------------------------------------------
-- which discount applies now
-- ---------------------------------------------------------------------
create or replace function private.time_rule_now(p_provider uuid)
returns table (percent numeric, title text, start_time time, end_time time)
language sql stable security definer set search_path = '' as $$
  with n as (select (now() at time zone 'Africa/Cairo') as t)
  select r.percent, r.title, r.start_time, r.end_time
  from public.discount_rules r, n
  where r.provider_id = p_provider and r.is_active and r.kind = 'time'
    and (r.days is null or extract(dow from n.t)::smallint = any (r.days))
    and case when r.start_time < r.end_time
             then n.t::time >= r.start_time and n.t::time < r.end_time
             else n.t::time >= r.start_time or n.t::time < r.end_time end   -- window over midnight
  order by r.percent desc
  limit 1
$$;

alter table public.scans add column if not exists discount_kind text
  check (discount_kind is null or discount_kind in ('standard', 'time', 'first'));
grant select (discount_kind) on public.scans to authenticated;

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
  v_trial record;
  v_use_trial boolean := false;
  v_tpct numeric;
  v_ttitle text;
  v_tfrom time;
  v_tto time;
  v_first numeric;
  v_is_first boolean := false;
  v_pct numeric;
  v_kind text;
  v_services jsonb;
begin
  if v_pid is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.hit_rate_limit('scan', v_pid::text, 30, 60) then raise exception 'rate_limited'; end if;
  select id, name, discount_percent, notes, limit_count, limit_period, allowed_days into v_provider
    from public.providers where id = v_pid;

  v_m := regexp_match(btrim(coalesce(p_token, '')), 'XG1\.([0-9a-f]{32})\.([0-9]{9,11})\.([0-9a-f]{32})');
  if v_m is null then
    insert into public.scans (provider_id, result) values (v_pid, 'invalid');
    return jsonb_build_object('status', 'invalid');
  end if;
  v_uid := v_m[1]::uuid;
  if private.sign_qr('XG1.' || v_m[1] || '.' || v_m[2] || '|' || private.active_sid(v_uid)) <> v_m[3] then
    insert into public.scans (provider_id, result) values (v_pid, 'invalid');
    return jsonb_build_object('status', 'invalid');
  end if;
  v_ts := v_m[2]::bigint;
  if v_ts < v_now - 180 or v_ts > v_now + 60 then
    insert into public.scans (provider_id, result) values (v_pid, 'stale');
    return jsonb_build_object('status', 'stale');
  end if;
  select id, first_name, last_name into v_profile from public.profiles where id = v_uid;
  if v_profile.id is null then
    insert into public.scans (provider_id, result) values (v_pid, 'invalid');
    return jsonb_build_object('status', 'invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));   -- per member: no double-spend anywhere
  v_label := v_profile.first_name || ' ' || left(v_profile.last_name, 1) || '.';
  v_state := private.membership_state(v_uid);
  v_usage := private.usage_state(v_uid, v_pid);
  select * into v_trial from public.trials where user_id = v_uid;

  if v_state->>'status' <> 'active' then
    if v_trial.user_id is not null and v_trial.used_at is null then
      v_use_trial := true;
    elsif v_trial.used_at is not null and v_trial.used_provider = v_pid and v_trial.used_at > now() - interval '15 minutes' then
      v_use_trial := true;                                              -- same checkout re-scanned
    else
      v_result := case when v_trial.user_id is not null then 'trial_used' else 'expired' end;
    end if;
  end if;

  if v_result is null then
    if not (v_usage->>'valid_today')::boolean then
      v_result := 'not_today';
    elsif exists (select 1 from public.scans s where s.provider_id = v_pid and s.member_id = v_uid and s.counted
                    and s.created_at > now() - interval '15 minutes') then
      v_result := 'active'; v_repeat := true;
    elsif v_provider.limit_count is not null and (v_usage->>'uses_left')::int <= 0 then
      v_result := 'limit_reached';
    else
      v_result := 'active'; v_counted := true;
    end if;
  end if;

  -- services are always shown (the partner applies them per service)
  select coalesce(jsonb_agg(jsonb_build_object('title', r.title, 'percent', r.percent) order by r.sort_order, r.percent desc, r.title), '[]'::jsonb)
    into v_services from public.discount_rules r where r.provider_id = v_pid and r.is_active and r.kind = 'service';

  if v_result = 'active' then
    v_pct := v_provider.discount_percent; v_kind := 'standard';
    select t.percent, t.title, t.start_time, t.end_time into v_tpct, v_ttitle, v_tfrom, v_tto from private.time_rule_now(v_pid) t;
    if v_tpct is not null and v_tpct > v_pct then v_pct := v_tpct; v_kind := 'time'; end if;
    select r.percent into v_first from public.discount_rules r where r.provider_id = v_pid and r.is_active and r.kind = 'first';
    if v_first is not null then
      -- first visit = no earlier visit here (a re-scan of the same checkout keeps it)
      v_is_first := not exists (select 1 from public.scans s where s.provider_id = v_pid and s.member_id = v_uid and s.counted
                                  and s.created_at <= now() - interval '15 minutes');
      if v_is_first and v_first > v_pct then v_pct := v_first; v_kind := 'first'; end if;
    end if;
  end if;

  insert into public.scans (provider_id, member_id, member_label, result, discount_percent, discount_kind, counted, trial)
  values (v_pid, v_uid, v_label, v_result, v_pct, v_kind, v_counted, v_use_trial and v_result = 'active');
  if v_counted and v_use_trial then
    update public.trials set used_at = now(), used_provider = v_pid where user_id = v_uid and used_at is null;
  end if;
  if v_counted then v_usage := private.usage_state(v_uid, v_pid); end if;

  return jsonb_build_object(
    'status', v_result,
    'member_name', v_label,
    'expires_at', v_state->'expires_at',
    'discount_percent', v_pct,
    'discount_kind', v_kind,
    'standard_percent', v_provider.discount_percent,
    'time_title', case when v_kind = 'time' then v_ttitle end,
    'time_from', case when v_kind = 'time' then to_char(v_tfrom, 'HH24:MI') end,
    'time_to', case when v_kind = 'time' then to_char(v_tto, 'HH24:MI') end,
    'services', case when v_result = 'active' then v_services else '[]'::jsonb end,
    'provider_name', v_provider.name,
    'notes', v_provider.notes,
    'repeat', v_repeat,
    'trial', v_use_trial and v_result = 'active',
    'usage', v_usage,
    'checked_at', now()
  );
end $$;
revoke all on function public.verify_member_qr(text) from public, anon;
grant execute on function public.verify_member_qr(text) to authenticated;

-- ---------------------------------------------------------------------
-- search + home feed: "up to" discount
-- ---------------------------------------------------------------------
drop function if exists public.search_providers(text, uuid, int, int, numeric, uuid);
create or replace function public.search_providers(
  p_q text, p_category uuid default null, p_limit int default 20, p_offset int default 0,
  p_min_discount numeric default null, p_area uuid default null
) returns table (id uuid, name text, image_path text, discount_percent numeric, max_percent numeric,
                 category_id uuid, area_id uuid, area_name text, areas_count int)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_q text := private.norm(left(coalesce(p_q, ''), 60));
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 20);
begin
  if length(v_q) = 0 then return; end if;
  return query
    select p.id, p.name, p.image_path, p.discount_percent, p.max_percent, p.category_id, p.area_id,
           coalesce(case when p_area is not null then (select a2.name from public.areas a2 where a2.id = p_area) end, a.name),
           cardinality(p.area_ids)
    from public.providers p
    left join public.categories c on c.id = p.category_id and c.is_active
    left join public.areas a on a.id = p.area_id
    where p.is_active
      and (p_category is null or p.category_id = p_category)
      and (p_area is null or p_area = any (p.area_ids))
      and (p_min_discount is null or p.max_percent >= p_min_discount)
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
revoke all on function public.search_providers(text, uuid, int, int, numeric, uuid) from public;
grant execute on function public.search_providers(text, uuid, int, int, numeric, uuid) to anon, authenticated;

create or replace function public.home_feed(p_area uuid default null, p_top int default 10, p_rows int default 5, p_per_row int default 10)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_top int := least(greatest(coalesce(p_top, 10), 1), 20);
  v_rows int := least(greatest(coalesce(p_rows, 5), 0), 10);
  v_per int := least(greatest(coalesce(p_per_row, 10), 1), 20);
  v_area_name text := (select name from public.areas where id = p_area);
  v_res jsonb;
begin
  with base as (
    select p.id, p.name, p.image_path, p.discount_percent, p.max_percent, p.category_id, p.sort_order,
           coalesce(v_area_name, a.name) as area_name, cardinality(p.area_ids) as areas_count,
           row_number() over (partition by coalesce(p.category_id, p.id)
                              order by p.max_percent desc, p.sort_order, p.name, p.id) as rk
    from public.providers p
    left join public.areas a on a.id = p.area_id
    where p.is_active and (p_area is null or p_area = any (p.area_ids))
  ),
  top as (
    select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'image_path', image_path, 'discount_percent', discount_percent,
                                        'max_percent', max_percent, 'area_name', area_name, 'areas_count', areas_count) order by ord) as items
    from (select *, row_number() over (order by rk, max_percent desc, sort_order, name, id) as ord from base) x
    where ord <= v_top
  ),
  cats as (
    select c.id, c.name, c.icon, c.sort_order
    from public.categories c
    where c.is_active and exists (select 1 from base b where b.category_id = c.id)
    order by c.sort_order, c.name
    limit v_rows
  ),
  rows as (
    select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'icon', c.icon,
             'items', (select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'image_path', b.image_path,
                                                           'discount_percent', b.discount_percent, 'max_percent', b.max_percent,
                                                           'area_name', b.area_name, 'areas_count', b.areas_count) order by b.rk)
                       from base b where b.category_id = c.id and b.rk <= v_per))
           order by c.sort_order, c.name) as items
    from cats c
  )
  select jsonb_build_object('top', coalesce((select items from top), '[]'::jsonb),
                            'rows', coalesce((select items from rows), '[]'::jsonb))
    into v_res;
  return v_res;
end $$;
revoke all on function public.home_feed(uuid, int, int, int) from public;
grant execute on function public.home_feed(uuid, int, int, int) to anon, authenticated;

create or replace function public.schema_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'version', 12,
    'm005', to_regclass('public.categories') is not null,
    'm006', to_regclass('public.complaints') is not null,
    'm007', to_regclass('public.areas') is not null,
    'm008', to_regclass('public.membership_requests') is not null,
    'm009', to_regclass('public.trials') is not null,
    'm010', to_regprocedure('public.home_feed(uuid, integer, integer, integer)') is not null,
    'm011', to_regclass('public.branches') is not null,
    'm012', to_regclass('public.discount_rules') is not null)
$$;
