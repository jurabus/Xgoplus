-- =====================================================================
-- XGo Plus — 008 payments (InstaPay / Vodafone Cash) + admin security
-- - payment mode: free | active (paid requests) | inactive
-- - payment accounts with automatic rotation every N submitted requests
-- - membership requests with a PRIVATE screenshot (bucket "proofs")
-- - admin access now requires: admins table + 2FA session (aal2) + IP not banned
-- - suspicious activity is logged per IP; enough of it bans the IP from admin
-- - schema_status(): lets the admin panel tell which update is missing
-- Idempotent. Run after 007.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0) schema status
-- ---------------------------------------------------------------------
create or replace function public.schema_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'version', 8,
    'm005', to_regclass('public.categories') is not null,
    'm006', to_regclass('public.complaints') is not null,
    'm007', to_regclass('public.areas') is not null,
    'm008', to_regclass('public.membership_requests') is not null)
$$;
revoke all on function public.schema_status() from public;
grant execute on function public.schema_status() to anon, authenticated;

-- ---------------------------------------------------------------------
-- 1) Security: client IP, events, bans
-- ---------------------------------------------------------------------
create table if not exists private.security_events (
  id bigint generated always as identity primary key,
  ip text not null,
  user_id uuid,
  kind text not null,
  detail text not null default '',
  weight int not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists security_events_ip_time on private.security_events (ip, created_at desc);
create index if not exists security_events_time on private.security_events (created_at desc);

create table if not exists private.ip_bans (
  ip text primary key,
  reason text not null default '',
  banned_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_by uuid
);

-- Client IP as seen by the API gateway (Cloudflare header first). Best effort.
create or replace function private.client_ip() returns text
language plpgsql stable set search_path = '' as $$
declare h json; v text;
begin
  begin h := nullif(current_setting('request.headers', true), '')::json; exception when others then h := null; end;
  v := coalesce(h->>'cf-connecting-ip', nullif(btrim(split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1)), ''), h->>'x-real-ip');
  v := left(regexp_replace(coalesce(v, ''), '[^0-9a-fA-F:.]', '', 'g'), 64);
  return coalesce(nullif(v, ''), 'unknown');
end $$;

create or replace function private.ip_banned(p_ip text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.ip_bans b where b.ip = p_ip and b.expires_at > now())
$$;

-- Record a suspicious event; 10+ points within an hour bans the IP from admin
-- for 24h (30 days if it was banned in the last 30 days).
create or replace function private.flag_ip(p_kind text, p_detail text, p_weight int) returns void
language plpgsql security definer set search_path = '' as $$
declare v_ip text := private.client_ip(); v_score int; v_repeat boolean;
begin
  if private.ip_banned(v_ip) then return; end if;                 -- already banned: don't grow the log
  if not private.hit_rate_limit('secev', v_ip, 200, 3600) then return; end if;
  insert into private.security_events (ip, user_id, kind, detail, weight)
  values (v_ip, auth.uid(), left(p_kind, 40), left(coalesce(p_detail, ''), 200), greatest(p_weight, 0));
  if v_ip = 'unknown' or p_weight <= 0 then return; end if;
  select coalesce(sum(weight), 0) into v_score from private.security_events
   where ip = v_ip and created_at > now() - interval '1 hour';
  if v_score >= 10 then
    select exists (select 1 from private.ip_bans where ip = v_ip and banned_at > now() - interval '30 days') into v_repeat;
    insert into private.ip_bans (ip, reason, banned_at, expires_at)
    values (v_ip, p_kind, now(), now() + case when v_repeat then interval '30 days' else interval '24 hours' end)
    on conflict (ip) do update set reason = excluded.reason, banned_at = now(), expires_at = excluded.expires_at, created_by = null;
  end if;
  if random() < 0.01 then delete from private.security_events where created_at < now() - interval '90 days'; end if;
end $$;

-- Admin = listed in admins + signed in with 2FA (aal2) + IP not banned.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid())
     and coalesce(auth.jwt()->>'aal', '') = 'aal2'
     and not private.ip_banned(private.client_ip())
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- Guard used by every admin RPC: logs non-admin callers (can't raise, or the log would roll back)
create or replace function private.admin_denied(p_what text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if public.is_admin() then return false; end if;
  perform private.flag_ip('admin_rpc_denied', p_what, 2);
  return true;
end $$;

-- Called by /admin.html: before login (banned?) and after password login (listed? 2FA?)
create or replace function public.admin_gate() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_ip text := private.client_ip(); v_listed boolean; v_aal text := coalesce(auth.jwt()->>'aal', '');
begin
  if private.ip_banned(v_ip) then return jsonb_build_object('banned', true); end if;
  if auth.uid() is null then return jsonb_build_object('banned', false, 'listed', false); end if;
  v_listed := exists (select 1 from public.admins where user_id = auth.uid());
  if not v_listed then
    perform private.flag_ip('non_admin_login', coalesce(auth.jwt()->>'email', ''), 4);
  elsif v_aal = 'aal2' and not exists (select 1 from private.security_events
        where user_id = auth.uid() and ip = v_ip and kind = 'admin_session' and created_at > now() - interval '6 hours') then
    perform private.flag_ip('admin_session', 'ok', 0);
  end if;
  return jsonb_build_object('banned', private.ip_banned(v_ip), 'listed', v_listed, 'aal', v_aal);
end $$;

create or replace function public.report_admin_failure(p_kind text, p_detail text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_kind = 'password' then perform private.flag_ip('admin_bad_password', left(coalesce(p_detail, ''), 120), 1);
  elsif p_kind = 'mfa' then perform private.flag_ip('admin_bad_2fa', left(coalesce(p_detail, ''), 120), 2);
  else perform private.flag_ip('admin_probe', left(coalesce(p_kind, ''), 40), 2);
  end if;
  return jsonb_build_object('banned', private.ip_banned(private.client_ip()));
end $$;
revoke all on function public.admin_gate() from public;
revoke all on function public.report_admin_failure(text, text) from public;
grant execute on function public.admin_gate() to anon, authenticated;
grant execute on function public.report_admin_failure(text, text) to anon, authenticated;

create or replace function public.admin_security_overview() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_security_overview') then return null; end if;
  return jsonb_build_object(
    'my_ip', private.client_ip(),
    'bans', coalesce((select jsonb_agg(jsonb_build_object('ip', ip, 'reason', reason, 'banned_at', banned_at, 'expires_at', expires_at) order by banned_at desc)
                      from private.ip_bans where expires_at > now()), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(e order by e.created_at desc) from (
        select s.ip, s.kind, s.detail, s.weight, s.created_at, u.email
        from private.security_events s left join auth.users u on u.id = s.user_id
        order by s.created_at desc limit 100) e), '[]'::jsonb));
end $$;

create or replace function public.admin_ban_ip(p_ip text, p_days int, p_reason text default 'manual') returns void
language plpgsql security definer set search_path = '' as $$
declare v_ip text := left(regexp_replace(coalesce(p_ip, ''), '[^0-9a-fA-F:.]', '', 'g'), 64);
begin
  if private.admin_denied('admin_ban_ip') then return; end if;
  if v_ip = '' or v_ip = 'unknown' then raise exception 'invalid_ip'; end if;
  if v_ip = private.client_ip() then raise exception 'cannot_ban_self'; end if;
  insert into private.ip_bans (ip, reason, banned_at, expires_at, created_by)
  values (v_ip, left(coalesce(p_reason, 'manual'), 120), now(), now() + make_interval(days => least(greatest(coalesce(p_days, 1), 1), 3650)), auth.uid())
  on conflict (ip) do update set reason = excluded.reason, banned_at = now(), expires_at = excluded.expires_at, created_by = auth.uid();
end $$;

create or replace function public.admin_unban_ip(p_ip text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_unban_ip') then return; end if;
  update private.ip_bans set expires_at = now() where ip = p_ip;
  delete from private.security_events where ip = p_ip and weight > 0;   -- fresh start, no instant re-ban
end $$;

-- ---------------------------------------------------------------------
-- 2) Admin RPCs re-declared with the logging guard (latest versions)
-- ---------------------------------------------------------------------
create or replace function public.admin_create_provider(
  p_username text, p_password text, p_name text, p_discount numeric, p_notes text default ''
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_email text; v_uid uuid := gen_random_uuid(); v_pid uuid := gen_random_uuid();
begin
  if private.admin_denied('admin_create_provider') then return null; end if;
  if v_username !~ '^[a-z0-9_]{3,30}$' then raise exception 'invalid_username'; end if;
  perform private.check_password(p_password);
  v_email := v_username || '@p.xgoplus.online';
  if exists (select 1 from public.providers where username = v_username)
     or exists (select 1 from auth.users where email = v_email) then
    raise exception 'username_taken';
  end if;
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated', v_email,
    extensions.crypt(p_password, extensions.gen_salt('bf')), now(), '', '', '', '',
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'xg_kind', 'provider'),
    '{}'::jsonb, now(), now());
  insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (v_uid::text, v_uid,
          jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true, 'phone_verified', false),
          'email', now(), now(), now());
  insert into public.providers (id, user_id, username, name, discount_percent, notes)
  values (v_pid, v_uid, v_username, p_name, p_discount, coalesce(p_notes, ''));
  return v_pid;
end $$;

create or replace function public.admin_update_provider(p_id uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_update_provider') then return; end if;
  update public.providers set
    name = case when p_patch ? 'name' then p_patch->>'name' else name end,
    discount_percent = case when p_patch ? 'discount_percent' then (p_patch->>'discount_percent')::numeric else discount_percent end,
    notes = case when p_patch ? 'notes' then coalesce(p_patch->>'notes', '') else notes end,
    image_path = case when p_patch ? 'image_path' then p_patch->>'image_path' else image_path end,
    is_active = case when p_patch ? 'is_active' then (p_patch->>'is_active')::boolean else is_active end,
    sort_order = case when p_patch ? 'sort_order' then (p_patch->>'sort_order')::int else sort_order end,
    category_id = case when p_patch ? 'category_id' then nullif(p_patch->>'category_id', '')::uuid else category_id end,
    area_id = case when p_patch ? 'area_id' then nullif(p_patch->>'area_id', '')::uuid else area_id end,
    limit_count = case when p_patch ? 'limit_count' then (p_patch->>'limit_count')::smallint else limit_count end,
    limit_period = case when p_patch ? 'limit_period' then nullif(p_patch->>'limit_period', '') else limit_period end,
    allowed_days = case when p_patch ? 'allowed_days' then
      (case when jsonb_typeof(p_patch->'allowed_days') = 'array'
            then (select array_agg(x::smallint) from jsonb_array_elements_text(p_patch->'allowed_days') x) end)
      else allowed_days end
  where id = p_id;
  if not found then raise exception 'not_found'; end if;
end $$;

create or replace function public.admin_set_provider_password(p_id uuid, p_password text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  if private.admin_denied('admin_set_provider_password') then return; end if;
  perform private.check_password(p_password);
  select user_id into v_uid from public.providers where id = p_id;
  if v_uid is null then raise exception 'not_found'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
  where id = v_uid;
end $$;

create or replace function public.admin_delete_provider(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  if private.admin_denied('admin_delete_provider') then return; end if;
  select user_id into v_uid from public.providers where id = p_id;
  delete from public.providers where id = p_id;
  if not found then raise exception 'not_found'; end if;
  if v_uid is not null then delete from auth.users where id = v_uid; end if;
end $$;

drop function if exists public.admin_list_providers(text, int, int);
create or replace function public.admin_list_providers(
  p_search text default '', p_limit int default 50, p_offset int default 0
) returns table (
  id uuid, username text, name text, image_path text, discount_percent numeric, notes text,
  is_active boolean, sort_order int, created_at timestamptz, category_id uuid, category_name text,
  area_id uuid, area_name text, total bigint
)
language plpgsql volatile security definer set search_path = '' as $$
declare v_q text := btrim(coalesce(p_search, ''));
begin
  if private.admin_denied('admin_list_providers') then return; end if;
  return query
    select p.id, p.username, p.name, p.image_path, p.discount_percent, p.notes,
           p.is_active, p.sort_order, p.created_at, p.category_id, c.name, p.area_id, a.name, count(*) over ()
    from public.providers p
    left join public.categories c on c.id = p.category_id
    left join public.areas a on a.id = p.area_id
    where v_q = '' or p.name ilike '%' || v_q || '%' or p.username ilike '%' || v_q || '%'
    order by p.sort_order, p.name, p.id
    limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;
-- (002 drops/re-creates this on a full re-run; fine)

create or replace function public.admin_list_members(
  p_search text default '', p_limit int default 50, p_offset int default 0
) returns table (
  id uuid, phone text, first_name text, last_name text, created_at timestamptz,
  expires_at timestamptz, status text, total bigint
)
language plpgsql volatile security definer set search_path = '' as $$
declare v_q text := btrim(coalesce(p_search, '')); v_digits text;
begin
  if private.admin_denied('admin_list_members') then return; end if;
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
  if private.admin_denied('admin_grant_membership') then return null; end if;
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
  if private.admin_denied('admin_revoke_membership') then return null; end if;
  delete from public.memberships where user_id = p_user_id and starts_at > now();
  update public.memberships set expires_at = now() where user_id = p_user_id and expires_at > now();
  return private.membership_state(p_user_id);
end $$;

create or replace function public.admin_list_scans(
  p_provider uuid default null, p_limit int default 50, p_offset int default 0
) returns table (
  id bigint, created_at timestamptz, provider_id uuid, provider_name text,
  member_id uuid, member_label text, member_phone text, result text, discount_percent numeric
)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_list_scans') then return; end if;
  return query
    select s.id, s.created_at, s.provider_id, p.name, s.member_id, s.member_label, pr.phone, s.result, s.discount_percent
    from public.scans s
    join public.providers p on p.id = s.provider_id
    left join public.profiles pr on pr.id = s.member_id
    where p_provider is null or s.provider_id = p_provider
    order by s.created_at desc, s.id desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

create or replace function public.admin_category_counts() returns table (category_id uuid, providers bigint)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_category_counts') then return; end if;
  return query select p.category_id, count(*) from public.providers p where p.category_id is not null group by p.category_id;
end $$;

create or replace function public.admin_area_counts() returns table (area_id uuid, providers bigint)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_area_counts') then return; end if;
  return query select p.area_id, count(*) from public.providers p where p.area_id is not null group by p.area_id;
end $$;

create or replace function public.admin_list_complaints(p_status text default null, p_limit int default 30, p_offset int default 0)
returns table (id uuid, created_at timestamptz, status text, reason text, details text, admin_note text,
               provider_id uuid, provider_name text, member_id uuid, member_name text, member_phone text,
               member_scans_here bigint, total bigint)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_list_complaints') then return; end if;
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
  if private.admin_denied('admin_update_complaint') then return; end if;
  if p_status not in ('open', 'in_review', 'resolved', 'dismissed') then raise exception 'invalid_status'; end if;
  update public.complaints set status = p_status, admin_note = left(btrim(coalesce(p_note, '')), 1000), updated_at = now()
  where id = p_id;
  if not found then raise exception 'not_found'; end if;
end $$;

-- ---------------------------------------------------------------------
-- 3) Payments
-- ---------------------------------------------------------------------
create table if not exists public.payment_accounts (
  id uuid primary key default gen_random_uuid(),
  method text not null check (method in ('instapay', 'vodafone')),
  value text not null check (length(value) between 3 and 120),
  label text not null default '' check (length(label) <= 60),
  sort_order int not null default 0,
  is_active boolean not null default true,
  uses_count int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists payment_accounts_method on public.payment_accounts (method, is_active, sort_order, id);
alter table public.payment_accounts enable row level security;
revoke all on public.payment_accounts from anon, authenticated;
grant select (id, method, value, label, sort_order, is_active, uses_count, created_at) on public.payment_accounts to authenticated;
grant insert (method, value, label, sort_order, is_active), update (value, label, sort_order, is_active), delete
  on public.payment_accounts to authenticated;
drop policy if exists payment_accounts_admin on public.payment_accounts;
create policy payment_accounts_admin on public.payment_accounts for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create or replace function private.payment_accounts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.value := btrim(regexp_replace(coalesce(new.value, ''), '[[:cntrl:]<>"'']', '', 'g'));
  new.label := btrim(regexp_replace(coalesce(new.label, ''), '[[:cntrl:]<>]', '', 'g'));
  if new.method = 'vodafone' then
    new.value := regexp_replace(new.value, '[^0-9]', '', 'g');
    if new.value !~ '^01[0-9]{9}$' then raise exception 'invalid_wallet_number'; end if;
  end if;
  if length(new.value) < 3 then raise exception 'invalid_account'; end if;
  return new;
end $$;
drop trigger if exists payment_accounts_guard on public.payment_accounts;
create trigger payment_accounts_guard before insert or update on public.payment_accounts
  for each row execute function private.payment_accounts_guard();

create table if not exists private.payment_counters (
  method text primary key,
  n bigint not null default 0
);

create table if not exists public.membership_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  method text not null check (method in ('instapay', 'vodafone')),
  account_id uuid references public.payment_accounts(id) on delete set null,
  account_value text not null,
  amount_egp numeric(10,2) not null,
  proof_path text,
  sender_info text not null default '' check (length(sender_info) <= 120),
  status text not null default 'draft' check (status in ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
  admin_note text not null default '' check (length(admin_note) <= 500),
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by uuid
);
create unique index if not exists membership_requests_one_open on public.membership_requests (user_id) where status in ('draft', 'pending');
create index if not exists membership_requests_status on public.membership_requests (status, submitted_at desc);
create index if not exists membership_requests_user on public.membership_requests (user_id, created_at desc);
alter table public.membership_requests enable row level security;
revoke all on public.membership_requests from anon, authenticated;   -- RPC access only

-- Private bucket for transfer screenshots
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proofs', 'proofs', false, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = 3145728,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists proofs_insert on storage.objects;
create policy proofs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'proofs'
              and (storage.foldername(name))[1] = (select auth.uid())::text
              and array_length(storage.foldername(name), 1) = 1
              and exists (select 1 from public.profiles p where p.id = (select auth.uid())));
drop policy if exists proofs_select on storage.objects;
create policy proofs_select on storage.objects for select to authenticated
  using (bucket_id = 'proofs' and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_admin()));
drop policy if exists proofs_delete on storage.objects;
create policy proofs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'proofs' and public.is_admin());

create or replace function private.setting_text(p_key text, p_default text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select case when jsonb_typeof(s.data->p_key) = 'string' then s.data->>p_key end
                   from public.settings s where s.id = 1), p_default)
$$;

-- free | active | inactive  (falls back to the old membership_free switch)
create or replace function private.payment_mode() returns text
language sql stable security definer set search_path = '' as $$
  select case when m in ('free', 'active', 'inactive') then m
              when private.setting_bool('membership_free', true) then 'free' else 'inactive' end
  from (select private.setting_text('payment_mode', '') as m) x
$$;

-- Free subscription only in "free" mode
create or replace function public.subscribe_membership() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_current timestamptz; v_start timestamptz;
  v_price numeric := private.setting_num('membership_price_egp', 199);
  v_renew_days numeric := private.setting_num('membership_renew_window_days', 30);
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if private.payment_mode() <> 'free' then raise exception 'payment_required'; end if;
  if not private.hit_rate_limit('subscribe', v_uid::text, 5, 3600) then raise exception 'rate_limited'; end if;
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

-- Public: what can a visitor do right now (no account numbers here)
create or replace function public.payment_options() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'mode', private.payment_mode(),
    'price', private.setting_num('membership_price_egp', 199),
    'methods', coalesce((select jsonb_agg(distinct method) from public.payment_accounts where is_active), '[]'::jsonb))
$$;
revoke all on function public.payment_options() from public;
grant execute on function public.payment_options() to anon, authenticated;

-- Customer picks a method -> gets the account to pay (rotates every N submitted requests)
create or replace function public.start_membership_payment(p_method text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_current timestamptz;
  v_every int := greatest(private.setting_num('payment_rotate_every', 5)::int, 1);
  v_price numeric := private.setting_num('membership_price_egp', 199);
  v_n bigint; v_acc record; v_cnt int; v_id uuid;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if private.payment_mode() <> 'active' then raise exception 'payments_unavailable'; end if;
  if p_method not in ('instapay', 'vodafone') then raise exception 'method_unavailable'; end if;
  if not private.hit_rate_limit('paystart', v_uid::text, 20, 3600) then raise exception 'rate_limited'; end if;
  perform 1 from public.profiles where id = v_uid for update;
  if exists (select 1 from public.membership_requests where user_id = v_uid and status = 'pending') then
    raise exception 'request_pending';
  end if;
  select max(expires_at) into v_current from public.memberships where user_id = v_uid;
  if v_current is not null and v_current > now() + make_interval(days => private.setting_num('membership_renew_window_days', 30)::int) then
    raise exception 'already_active';
  end if;
  select count(*) into v_cnt from public.payment_accounts where method = p_method and is_active;
  if v_cnt = 0 then raise exception 'method_unavailable'; end if;
  select coalesce((select n from private.payment_counters where method = p_method), 0) into v_n;
  select id, value into v_acc from public.payment_accounts where method = p_method and is_active
   order by sort_order, created_at, id offset ((v_n / v_every) % v_cnt) limit 1;

  update public.membership_requests set method = p_method, account_id = v_acc.id, account_value = v_acc.value,
         amount_egp = v_price, created_at = now()
   where user_id = v_uid and status = 'draft' returning id into v_id;
  if v_id is null then
    insert into public.membership_requests (user_id, method, account_id, account_value, amount_egp)
    values (v_uid, p_method, v_acc.id, v_acc.value, v_price) returning id into v_id;
  end if;
  return jsonb_build_object('request_id', v_id, 'method', p_method, 'account_value', v_acc.value, 'amount', v_price);
end $$;

create or replace function public.submit_membership_request(p_request uuid, p_proof_path text, p_sender text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_r record;
begin
  if v_uid is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if private.payment_mode() <> 'active' then raise exception 'payments_unavailable'; end if;
  select * into v_r from public.membership_requests where id = p_request and user_id = v_uid and status = 'draft' for update;
  if v_r.id is null then raise exception 'not_found'; end if;
  if coalesce(p_proof_path, '') !~ ('^' || v_uid::text || '/' || p_request::text || '-[A-Za-z0-9]{4,20}\.(jpg|jpeg|png|webp)$')
     or not exists (select 1 from storage.objects o where o.bucket_id = 'proofs' and o.name = p_proof_path) then
    raise exception 'proof_required';
  end if;
  update public.membership_requests set proof_path = p_proof_path, status = 'pending', submitted_at = now(),
         sender_info = left(btrim(regexp_replace(coalesce(p_sender, ''), '[[:cntrl:]<>]', '', 'g')), 120)
   where id = p_request;
  insert into private.payment_counters as c (method, n) values (v_r.method, 1)
  on conflict (method) do update set n = c.n + 1;
  update public.payment_accounts set uses_count = uses_count + 1 where id = v_r.account_id;
  return jsonb_build_object('status', 'pending');
end $$;

create or replace function public.cancel_membership_request() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.membership_requests set status = 'cancelled', decided_at = now()
   where user_id = auth.uid() and status in ('draft', 'pending');
end $$;

create or replace function public.my_membership_request() returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(r) from (
    select id, method, account_value, amount_egp, status, admin_note, created_at, submitted_at, decided_at
    from public.membership_requests where user_id = auth.uid() and status <> 'cancelled'
    order by created_at desc limit 1) r
$$;

revoke all on function public.start_membership_payment(text) from public, anon;
revoke all on function public.submit_membership_request(uuid, text, text) from public, anon;
revoke all on function public.cancel_membership_request() from public, anon;
revoke all on function public.my_membership_request() from public, anon;
grant execute on function public.start_membership_payment(text) to authenticated;
grant execute on function public.submit_membership_request(uuid, text, text) to authenticated;
grant execute on function public.cancel_membership_request() to authenticated;
grant execute on function public.my_membership_request() to authenticated;

-- Admin: requests
create or replace function public.admin_list_requests(p_status text default 'pending', p_limit int default 30, p_offset int default 0)
returns table (id uuid, created_at timestamptz, submitted_at timestamptz, decided_at timestamptz, status text, method text,
               account_value text, amount_egp numeric, proof_path text, sender_info text, admin_note text,
               user_id uuid, member_name text, member_phone text, member_status text, total bigint)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_list_requests') then return; end if;
  return query
    select r.id, r.created_at, r.submitted_at, r.decided_at, r.status, r.method, r.account_value, r.amount_egp,
           r.proof_path, r.sender_info, r.admin_note, r.user_id, p.first_name || ' ' || p.last_name, p.phone,
           private.membership_state(r.user_id)->>'status', count(*) over ()
    from public.membership_requests r join public.profiles p on p.id = r.user_id
    where r.status <> 'draft' and (p_status is null or p_status = '' or r.status = p_status)
    order by (r.status = 'pending') desc, coalesce(r.submitted_at, r.created_at) asc, r.id
    limit least(greatest(coalesce(p_limit, 30), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

create or replace function public.admin_decide_request(p_id uuid, p_approve boolean, p_note text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_r record; v_current timestamptz; v_start timestamptz;
begin
  if private.admin_denied('admin_decide_request') then return null; end if;
  select * into v_r from public.membership_requests where id = p_id for update;
  if v_r.id is null then raise exception 'not_found'; end if;
  if v_r.status <> 'pending' then raise exception 'already_decided'; end if;
  if p_approve then
    perform 1 from public.profiles where id = v_r.user_id for update;
    select max(expires_at) into v_current from public.memberships where user_id = v_r.user_id;
    v_start := greatest(now(), coalesce(v_current, now()));
    insert into public.memberships (user_id, starts_at, expires_at, list_price_egp, paid_egp, source, created_by)
    values (v_r.user_id, v_start, v_start + interval '1 year', v_r.amount_egp, v_r.amount_egp, 'payment', auth.uid());
  end if;
  update public.membership_requests set status = case when p_approve then 'approved' else 'rejected' end,
         admin_note = left(btrim(coalesce(p_note, '')), 500), decided_at = now(), decided_by = auth.uid()
   where id = p_id;
  return private.membership_state(v_r.user_id);
end $$;

create or replace function public.admin_payment_overview() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_every int := greatest(private.setting_num('payment_rotate_every', 5)::int, 1);
begin
  if private.admin_denied('admin_payment_overview') then return null; end if;
  return jsonb_build_object(
    'mode', private.payment_mode(), 'rotate_every', v_every,
    'counters', coalesce((select jsonb_object_agg(method, n) from private.payment_counters), '{}'::jsonb),
    'current', (select jsonb_object_agg(m.method, (
        select a.id from public.payment_accounts a where a.method = m.method and a.is_active
        order by a.sort_order, a.created_at, a.id
        offset ((coalesce((select n from private.payment_counters c where c.method = m.method), 0) / v_every)
                % greatest((select count(*) from public.payment_accounts a2 where a2.method = m.method and a2.is_active), 1))
        limit 1))
      from (values ('instapay'), ('vodafone')) m(method)),
    'pending', (select count(*) from public.membership_requests where status = 'pending'));
end $$;

revoke all on function public.admin_list_requests(text, int, int) from public;
revoke all on function public.admin_decide_request(uuid, boolean, text) from public;
revoke all on function public.admin_payment_overview() from public;

create or replace function public.admin_stats() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_stats') then return null; end if;
  return jsonb_build_object(
    'providers', (select count(*) from public.providers),
    'providers_active', (select count(*) from public.providers where is_active),
    'members', (select count(*) from public.profiles),
    'members_active', (select count(distinct user_id) from public.memberships where starts_at <= now() and expires_at > now()),
    'scans_today', (select count(*) from public.scans where created_at >= date_trunc('day', now())),
    'scans_total', (select count(*) from public.scans),
    'complaints_open', (select count(*) from public.complaints where status in ('open', 'in_review')),
    'requests_pending', (select count(*) from public.membership_requests where status = 'pending'),
    'bans_active', (select count(*) from private.ip_bans where expires_at > now())
  );
end $$;

-- Every admin RPC may be called by anyone: non-admin calls are logged (and can lead to an IP ban)
do $$
declare f text;
begin
  foreach f in array array[
    'admin_create_provider(text, text, text, numeric, text)', 'admin_update_provider(uuid, jsonb)',
    'admin_set_provider_password(uuid, text)', 'admin_delete_provider(uuid)', 'admin_list_providers(text, int, int)',
    'admin_list_members(text, int, int)', 'admin_grant_membership(uuid, int)', 'admin_revoke_membership(uuid)',
    'admin_list_scans(uuid, int, int)', 'admin_stats()', 'admin_category_counts()', 'admin_area_counts()',
    'admin_list_complaints(text, int, int)', 'admin_update_complaint(uuid, text, text)',
    'admin_list_requests(text, int, int)', 'admin_decide_request(uuid, boolean, text)', 'admin_payment_overview()',
    'admin_security_overview()', 'admin_ban_ip(text, int, text)', 'admin_unban_ip(text)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;

