-- =====================================================================
-- XGo Plus — 004 provider QR scanner module
-- Providers scan a customer's membership QR; the database checks the
-- signature, age, membership validity and returns the discount.
-- Idempotent.
-- =====================================================================

create table if not exists public.scans (
  id bigint generated always as identity primary key,
  provider_id uuid not null references public.providers(id) on delete cascade,
  member_id uuid references public.profiles(id) on delete set null,
  member_label text not null default '',
  result text not null check (result in ('active', 'expired', 'invalid', 'stale')),
  discount_percent numeric(5,2),
  created_at timestamptz not null default now()
);
create index if not exists scans_provider_time on public.scans (provider_id, created_at desc);
create index if not exists scans_time on public.scans (created_at desc);
create index if not exists scans_member on public.scans (member_id);
alter table public.scans enable row level security;
revoke all on public.scans from anon, authenticated;
grant select (id, provider_id, member_label, result, discount_percent, created_at) on public.scans to authenticated;

drop policy if exists scans_read on public.scans;
create policy scans_read on public.scans for select to authenticated
  using (provider_id = (select public.my_provider_id()) or (select public.is_admin()));

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
  v_label text;
  v_result text;
begin
  if v_pid is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.hit_rate_limit('scan', v_pid::text, 30, 60) then
    raise exception 'rate_limited';
  end if;
  select id, name, discount_percent, notes into v_provider from public.providers where id = v_pid;

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

  v_label := v_profile.first_name || ' ' || left(v_profile.last_name, 1) || '.';
  v_state := private.membership_state(v_uid);
  v_result := case when v_state->>'status' = 'active' then 'active' else 'expired' end;

  insert into public.scans (provider_id, member_id, member_label, result, discount_percent)
  values (v_pid, v_uid, v_label, v_result,
          case when v_result = 'active' then v_provider.discount_percent end);

  return jsonb_build_object(
    'status', v_result,
    'member_name', v_label,
    'expires_at', v_state->'expires_at',
    'discount_percent', case when v_result = 'active' then v_provider.discount_percent end,
    'provider_name', v_provider.name,
    'notes', v_provider.notes,
    'checked_at', now()
  );
end $$;
revoke all on function public.verify_member_qr(text) from public, anon;
grant execute on function public.verify_member_qr(text) to authenticated;

-- ---------------------------------------------------------------------
-- Admin: scan log + dashboard numbers
-- ---------------------------------------------------------------------
create or replace function public.admin_list_scans(
  p_provider uuid default null, p_limit int default 50, p_offset int default 0
) returns table (
  id bigint, created_at timestamptz, provider_id uuid, provider_name text,
  member_id uuid, member_label text, member_phone text, result text, discount_percent numeric
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_admin();
  return query
    select s.id, s.created_at, s.provider_id, p.name, s.member_id, s.member_label, pr.phone, s.result, s.discount_percent
    from public.scans s
    join public.providers p on p.id = s.provider_id
    left join public.profiles pr on pr.id = s.member_id
    where p_provider is null or s.provider_id = p_provider
    order by s.created_at desc, s.id desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

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
    'scans_total', (select count(*) from public.scans)
  );
end $$;

revoke all on function public.admin_list_scans(uuid, int, int) from public, anon;
revoke all on function public.admin_stats() from public, anon;
grant execute on function public.admin_list_scans(uuid, int, int) to authenticated;
grant execute on function public.admin_stats() to authenticated;
