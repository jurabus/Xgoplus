-- =====================================================================
-- XGo Plus — 009
-- 1) Partners can no longer change their discount or usage limits (admin only)
-- 2) Free trial: every customer account can start ONE free trial = 1 discounted scan
-- 3) One active session per customer account: a new login revokes all others;
--    QR codes are bound to the active session
-- 4) InstaPay payment links (https://ipn.eg/S/<name>/instapay/<code>) per address
-- Idempotent. Run after 008.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Partner edits: name, image, notes only
-- ---------------------------------------------------------------------
revoke update (discount_percent, limit_count, limit_period, allowed_days) on public.providers from authenticated;
grant update (name, image_path, notes) on public.providers to authenticated;

-- ---------------------------------------------------------------------
-- 3) Single session per customer account
-- ---------------------------------------------------------------------
create table if not exists private.active_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  session_id text not null,
  claimed_at timestamptz not null default now()
);

create or replace function private.current_sid() returns text
language sql stable set search_path = '' as $$ select coalesce(auth.jwt()->>'session_id', '') $$;

create or replace function private.active_sid(p_uid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select session_id from private.active_sessions where user_id = p_uid), '')
$$;

-- true unless this is a customer session that was replaced by a newer login
create or replace function public.session_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is null
      or not exists (select 1 from private.active_sessions s where s.user_id = auth.uid() and s.session_id <> private.current_sid())
$$;
revoke all on function public.session_ok() from public;
grant execute on function public.session_ok() to anon, authenticated;

create or replace function private.require_session() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.session_ok() then raise exception 'session_revoked' using errcode = '42501'; end if;
end $$;

-- Called right after a customer logs in / signs up: this session becomes the only one.
create or replace function public.claim_session() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_sid text := private.current_sid(); v_n int := 0;
begin
  if v_uid is null or v_sid = '' then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = v_uid) then
    return jsonb_build_object('claimed', false);          -- partners/admins may use several devices
  end if;
  if not private.hit_rate_limit('claim', v_uid::text, 30, 3600) then raise exception 'rate_limited'; end if;
  insert into private.active_sessions (user_id, session_id) values (v_uid, v_sid)
  on conflict (user_id) do update set session_id = excluded.session_id, claimed_at = now();
  delete from auth.sessions where user_id = v_uid and id::text <> v_sid;   -- revokes their refresh tokens too
  get diagnostics v_n = row_count;
  return jsonb_build_object('claimed', true, 'revoked', v_n);
end $$;
revoke all on function public.claim_session() from public, anon;
grant execute on function public.claim_session() to authenticated;

-- Direct table writes by customers also need the active session
drop policy if exists profiles_own_update on public.profiles;
create policy profiles_own_update on public.profiles for update to authenticated
  using (id = (select auth.uid()) and (select public.session_ok()))
  with check (id = (select auth.uid()) and (select public.session_ok()));
drop policy if exists proofs_insert on storage.objects;
create policy proofs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'proofs'
              and (storage.foldername(name))[1] = (select auth.uid())::text
              and array_length(storage.foldername(name), 1) = 1
              and exists (select 1 from public.profiles p where p.id = (select auth.uid()))
              and public.session_ok());

-- ---------------------------------------------------------------------
-- 2) Free trial (1 scan)
-- ---------------------------------------------------------------------
create table if not exists public.trials (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  started_at timestamptz not null default now(),
  used_at timestamptz,
  used_provider uuid references public.providers(id) on delete set null
);
alter table public.trials enable row level security;
revoke all on public.trials from anon, authenticated;            -- via RPCs only

alter table public.scans add column if not exists trial boolean not null default false;
alter table public.scans drop constraint if exists scans_result_check;
alter table public.scans add constraint scans_result_check
  check (result in ('active', 'expired', 'invalid', 'stale', 'limit_reached', 'not_today', 'trial_used'));

create or replace function private.trial_state(p_uid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when not private.setting_bool('trial_enabled', true) and not exists (select 1 from public.trials t where t.user_id = p_uid and t.used_at is null) then
      case when exists (select 1 from public.trials t where t.user_id = p_uid) then 'used' else 'disabled' end
    when not exists (select 1 from public.trials t where t.user_id = p_uid) then 'available'
    when exists (select 1 from public.trials t where t.user_id = p_uid and t.used_at is null) then 'active'
    else 'used' end
$$;

create or replace function public.start_trial() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.require_session();
  if not private.setting_bool('trial_enabled', true) then raise exception 'trial_unavailable'; end if;
  if private.membership_state(v_uid)->>'status' = 'active' then raise exception 'already_active'; end if;
  insert into public.trials (user_id) values (v_uid) on conflict (user_id) do nothing;
  if not found then raise exception 'trial_used'; end if;
  return jsonb_build_object('trial', private.trial_state(v_uid));
end $$;
revoke all on function public.start_trial() from public, anon;
grant execute on function public.start_trial() to authenticated;

-- QR token: XG1.<user>.<time>.<hmac(payload | active session)> -> a token from a replaced login is invalid
create or replace function public.get_member_qr() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_payload text;
  v_state jsonb;
  v_trial text;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.require_session();
  v_state := private.membership_state(v_uid);
  v_trial := private.trial_state(v_uid);
  if v_state->>'status' = 'none' and v_trial not in ('active', 'used') then raise exception 'no_membership'; end if;
  if not private.hit_rate_limit('qr', v_uid::text, 240, 3600) then raise exception 'rate_limited'; end if;
  v_payload := 'XG1.' || replace(v_uid::text, '-', '') || '.' || floor(extract(epoch from now()))::bigint::text;
  return v_state || jsonb_build_object(
    'token', v_payload || '.' || private.sign_qr(v_payload || '|' || private.active_sid(v_uid)),
    'ttl_seconds', 180, 'trial', v_trial);
end $$;
revoke all on function public.get_member_qr() from public, anon;
grant execute on function public.get_member_qr() to authenticated;

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

  insert into public.scans (provider_id, member_id, member_label, result, discount_percent, counted, trial)
  values (v_pid, v_uid, v_label, v_result,
          case when v_result = 'active' then v_provider.discount_percent end, v_counted, v_use_trial and v_result = 'active');
  if v_counted and v_use_trial then
    update public.trials set used_at = now(), used_provider = v_pid where user_id = v_uid and used_at is null;
  end if;
  if v_counted then v_usage := private.usage_state(v_uid, v_pid); end if;

  return jsonb_build_object(
    'status', v_result,
    'member_name', v_label,
    'expires_at', v_state->'expires_at',
    'discount_percent', case when v_result = 'active' then v_provider.discount_percent end,
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

create or replace function public.get_my_context() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_profile jsonb; v_provider jsonb; v_admin boolean;
begin
  if v_uid is null then return jsonb_build_object('role', 'guest'); end if;
  if not public.session_ok() then return jsonb_build_object('role', 'revoked'); end if;
  v_admin := public.is_admin();
  select to_jsonb(p) - 'updated_at' into v_profile from public.profiles p where p.id = v_uid;
  select jsonb_build_object('id', p.id, 'username', p.username, 'name', p.name, 'image_path', p.image_path,
                            'discount_percent', p.discount_percent, 'notes', p.notes, 'is_active', p.is_active,
                            'area_name', a.name)
    into v_provider from public.providers p left join public.areas a on a.id = p.area_id where p.user_id = v_uid;
  return jsonb_build_object(
    'role', case when v_admin then 'admin'
                 when v_provider is not null and (v_provider->>'is_active')::boolean then 'provider'
                 when v_profile is not null then 'customer' else 'none' end,
    'is_admin', v_admin,
    'profile', v_profile,
    'provider', v_provider,
    'membership', case when v_profile is not null then private.membership_state(v_uid) end,
    'trial', case when v_profile is not null then private.trial_state(v_uid) end
  );
end $$;
revoke all on function public.get_my_context() from public;
grant execute on function public.get_my_context() to anon, authenticated;

-- Session checks on the other customer actions
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
  perform private.require_session();
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

-- ---------------------------------------------------------------------
-- 4) InstaPay payment link per address
-- ---------------------------------------------------------------------
alter table public.payment_accounts add column if not exists pay_link text;
alter table public.payment_accounts drop constraint if exists payment_accounts_pay_link_check;
alter table public.payment_accounts add constraint payment_accounts_pay_link_check
  check (pay_link is null or pay_link ~ '^https://ipn\.eg/S/[A-Za-z0-9._-]{1,64}/instapay/[A-Za-z0-9]{3,20}$');
grant select (pay_link) on public.payment_accounts to authenticated;
grant insert (pay_link), update (pay_link) on public.payment_accounts to authenticated;

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
  perform private.require_session();
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
  select id, value, pay_link into v_acc from public.payment_accounts where method = p_method and is_active
   order by sort_order, created_at, id offset ((v_n / v_every) % v_cnt) limit 1;
  update public.membership_requests set method = p_method, account_id = v_acc.id, account_value = v_acc.value,
         amount_egp = v_price, created_at = now()
   where user_id = v_uid and status = 'draft' returning id into v_id;
  if v_id is null then
    insert into public.membership_requests (user_id, method, account_id, account_value, amount_egp)
    values (v_uid, p_method, v_acc.id, v_acc.value, v_price) returning id into v_id;
  end if;
  return jsonb_build_object('request_id', v_id, 'method', p_method, 'account_value', v_acc.value,
                            'pay_link', v_acc.pay_link, 'amount', v_price);
end $$;

create or replace function public.submit_membership_request(p_request uuid, p_proof_path text, p_sender text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_r record;
begin
  if v_uid is null then raise exception 'forbidden' using errcode = '42501'; end if;
  perform private.require_session();
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

create or replace function public.file_complaint(p_provider uuid, p_reason text, p_details text default '')
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_id uuid; v_details text;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.require_session();
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

-- Admin overview counts trials too
create or replace function public.schema_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'version', 10,
    'm005', to_regclass('public.categories') is not null,
    'm006', to_regclass('public.complaints') is not null,
    'm007', to_regclass('public.areas') is not null,
    'm008', to_regclass('public.membership_requests') is not null,
    'm009', to_regclass('public.trials') is not null,
    'm010', to_regprocedure('public.home_feed(uuid, integer, integer, integer)') is not null)
$$;
