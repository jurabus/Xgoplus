-- =====================================================================
-- XGo Plus — 003 membership module
-- Yearly membership (list price from settings, free while
-- settings.membership_free is not false). Signed, short-lived QR tokens.
-- Idempotent.
-- =====================================================================

create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  starts_at timestamptz not null,
  expires_at timestamptz not null,
  list_price_egp numeric(10,2) not null default 0,
  paid_egp numeric(10,2) not null default 0,
  source text not null check (source in ('free', 'admin', 'payment')),
  created_by uuid,
  created_at timestamptz not null default now(),
  check (expires_at >= starts_at)
);
create index if not exists memberships_user_exp on public.memberships (user_id, expires_at desc);
alter table public.memberships enable row level security;
revoke all on public.memberships from anon, authenticated;
grant select (id, user_id, starts_at, expires_at, list_price_egp, paid_egp, source, created_at)
  on public.memberships to authenticated;

drop policy if exists memberships_read on public.memberships;
create policy memberships_read on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- Current state for one user
create or replace function private.membership_state(p_uid uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_max timestamptz; v_active_start timestamptz;
begin
  select max(m.expires_at) into v_max from public.memberships m where m.user_id = p_uid;
  if v_max is null then return jsonb_build_object('status', 'none'); end if;
  select min(m.starts_at) into v_active_start from public.memberships m
   where m.user_id = p_uid and m.expires_at > now();
  return jsonb_build_object(
    'status', case when v_active_start is not null and v_active_start <= now() then 'active' else 'expired' end,
    'starts_at', v_active_start,
    'expires_at', v_max);
end $$;

create or replace function private.setting_num(p_key text, p_default numeric) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select case when jsonb_typeof(s.data->p_key) = 'number' then (s.data->>p_key)::numeric end
     from public.settings s where s.id = 1),
    p_default)
$$;
create or replace function private.setting_bool(p_key text, p_default boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select case when jsonb_typeof(s.data->p_key) = 'boolean' then (s.data->>p_key)::boolean end
     from public.settings s where s.id = 1),
    p_default)
$$;

-- Customer subscribes. Free for now; price recalculated server-side.
create or replace function public.subscribe_membership() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_current timestamptz;
  v_start timestamptz;
  v_price numeric := private.setting_num('membership_price_egp', 199);
  v_renew_days numeric := private.setting_num('membership_renew_window_days', 30);
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not private.setting_bool('membership_free', true) then
    raise exception 'payment_required';
  end if;
  if not private.hit_rate_limit('subscribe', v_uid::text, 5, 3600) then
    raise exception 'rate_limited';
  end if;
  -- serialize concurrent calls for the same user
  perform 1 from public.profiles where id = v_uid for update;
  select max(expires_at) into v_current from public.memberships where user_id = v_uid;
  if v_current is not null and v_current > now() + make_interval(days => v_renew_days::int) then
    raise exception 'already_active';
  end if;
  v_start := greatest(now(), coalesce(v_current, now()));
  insert into public.memberships (user_id, starts_at, expires_at, list_price_egp, paid_egp, source, created_by)
  values (v_uid, v_start, v_start + interval '1 year', v_price, 0, 'free', v_uid);
  return private.membership_state(v_uid);
end $$;

-- QR token: XG1.<user hex>.<unix ts>.<hmac 128-bit hex>. Valid ~3 minutes.
create or replace function private.sign_qr(p_payload text) returns text
language sql stable security definer set search_path = '' as $$
  select left(encode(extensions.hmac(convert_to(p_payload, 'UTF8'),
               (select value from private.app_secrets where name = 'qr_hmac'), 'sha256'), 'hex'), 32)
$$;

create or replace function public.get_member_qr() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_payload text;
  v_state jsonb;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_state := private.membership_state(v_uid);
  if v_state->>'status' = 'none' then raise exception 'no_membership'; end if;
  if not private.hit_rate_limit('qr', v_uid::text, 240, 3600) then
    raise exception 'rate_limited';
  end if;
  v_payload := 'XG1.' || replace(v_uid::text, '-', '') || '.' || floor(extract(epoch from now()))::bigint::text;
  return v_state || jsonb_build_object('token', v_payload || '.' || private.sign_qr(v_payload), 'ttl_seconds', 180);
end $$;

-- Context RPC now includes membership.
create or replace function public.get_my_context() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_profile jsonb; v_provider jsonb; v_admin boolean;
begin
  if v_uid is null then return jsonb_build_object('role', 'guest'); end if;
  v_admin := public.is_admin();
  select to_jsonb(p) - 'updated_at' into v_profile from public.profiles p where p.id = v_uid;
  select jsonb_build_object('id', p.id, 'username', p.username, 'name', p.name, 'image_path', p.image_path,
                            'discount_percent', p.discount_percent, 'notes', p.notes, 'is_active', p.is_active)
    into v_provider from public.providers p where p.user_id = v_uid;
  return jsonb_build_object(
    'role', case when v_admin then 'admin'
                 when v_provider is not null and (v_provider->>'is_active')::boolean then 'provider'
                 when v_profile is not null then 'customer' else 'none' end,
    'is_admin', v_admin,
    'profile', v_profile,
    'provider', v_provider,
    'membership', case when v_profile is not null then private.membership_state(v_uid) end
  );
end $$;

-- ---------------------------------------------------------------------
-- Admin: members
-- ---------------------------------------------------------------------
create or replace function public.admin_list_members(
  p_search text default '', p_limit int default 50, p_offset int default 0
) returns table (
  id uuid, phone text, first_name text, last_name text, created_at timestamptz,
  expires_at timestamptz, status text, total bigint
)
language plpgsql stable security definer set search_path = '' as $$
declare v_q text := btrim(coalesce(p_search, '')); v_digits text;
begin
  perform private.assert_admin();
  v_digits := regexp_replace(v_q, '[^0-9]', '', 'g');
  if v_digits ~ '^0' then v_digits := '2' || v_digits; end if;
  return query
    select p.id, p.phone, p.first_name, p.last_name, p.created_at, m.exp,
           case when m.exp is null then 'none' when m.exp > now() then 'active' else 'expired' end,
           count(*) over ()
    from public.profiles p
    left join lateral (select max(x.expires_at) as exp from public.memberships x where x.user_id = p.id) m on true
    where v_q = ''
       or (length(v_digits) >= 3 and p.phone like '%' || v_digits || '%')
       or (p.first_name || ' ' || p.last_name) ilike '%' || v_q || '%'
    order by p.created_at desc, p.id
    limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

create or replace function public.admin_grant_membership(p_user_id uuid, p_days int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_current timestamptz; v_start timestamptz;
begin
  perform private.assert_admin();
  if p_days is null or p_days < 1 or p_days > 3660 then raise exception 'invalid_days'; end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then raise exception 'not_found'; end if;
  select max(expires_at) into v_current from public.memberships where user_id = p_user_id;
  v_start := greatest(now(), coalesce(v_current, now()));
  insert into public.memberships (user_id, starts_at, expires_at, list_price_egp, paid_egp, source, created_by)
  values (p_user_id, v_start, v_start + make_interval(days => p_days), 0, 0, 'admin', auth.uid());
  return private.membership_state(p_user_id);
end $$;

create or replace function public.admin_revoke_membership(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_admin();
  -- end every current/future period now (keeps history)
  delete from public.memberships where user_id = p_user_id and starts_at > now();
  update public.memberships set expires_at = now()
  where user_id = p_user_id and expires_at > now();
  return private.membership_state(p_user_id);
end $$;

revoke all on function public.subscribe_membership() from public, anon;
revoke all on function public.get_member_qr() from public, anon;
revoke all on function public.admin_list_members(text, int, int) from public, anon;
revoke all on function public.admin_grant_membership(uuid, int) from public, anon;
revoke all on function public.admin_revoke_membership(uuid) from public, anon;
grant execute on function public.subscribe_membership() to authenticated;
grant execute on function public.get_member_qr() to authenticated;
grant execute on function public.admin_list_members(text, int, int) to authenticated;
grant execute on function public.admin_grant_membership(uuid, int) to authenticated;
grant execute on function public.admin_revoke_membership(uuid) to authenticated;
revoke all on function public.get_my_context() from public;
grant execute on function public.get_my_context() to anon, authenticated;
