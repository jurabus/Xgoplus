-- =====================================================================
-- XGo Plus — 018 referral commissions + member wallet
--  * Every member gets a referral code (6 characters) and a wallet.
--  * A new member can enter a code at sign-up (or within 7 days, before
--    paying). When that member pays for a yearly membership, the referrer
--    earns settings.referral_commission_pct (default 50%) of the price paid,
--    rounded to the nearest pound, in their wallet. By default only the
--    first paid year counts (settings.referral_on_renewals = false).
--  * The wallet is an append-only ledger (wallet_entries). Balance = sum.
--  * Members can pay their own membership from the wallet, or ask for a
--    cash withdrawal to InstaPay / a mobile wallet (phone number required,
--    minimum settings.referral_min_withdrawal, default 100 EGP). The amount
--    is held at once; the admin pays it by hand within
--    settings.referral_payout_days (default 3) and marks it paid, or rejects
--    it (money back to the wallet). Members see the status and the due date.
--  * Switch: Admin → Modules → "Referral program" (on by default). Off = no
--    new commissions and no new codes accepted; balances stay usable.
-- Idempotent. Run after 017.
-- =====================================================================

create or replace function private.referrals_on() returns boolean
language sql stable security definer set search_path = '' as $$
  select not coalesce((select (data->'app_disabled_modules') ? 'referrals' from public.settings where id = 1), false)
$$;

-- ---------------------------------------------------------------------
-- 1) Codes + who referred whom
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists referral_code text;
alter table public.profiles add column if not exists referred_by uuid references public.profiles(id) on delete set null;
alter table public.profiles add column if not exists referred_at timestamptz;
create unique index if not exists profiles_referral_code on public.profiles (referral_code);
create index if not exists profiles_referred_by on public.profiles (referred_by) where referred_by is not null;
grant select (referral_code, referred_by, referred_at) on public.profiles to authenticated;

create or replace function private.new_referral_code() returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v_alpha text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; v_code text; v_b bytea; i int;
begin
  loop
    v_b := extensions.gen_random_bytes(6); v_code := '';
    for i in 0..5 loop v_code := v_code || substr(v_alpha, (get_byte(v_b, i) % 31) + 1, 1); end loop;
    exit when not exists (select 1 from public.profiles where referral_code = v_code);
  end loop;
  return v_code;
end $$;

create or replace function private.norm_code(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')), '')
$$;

-- keep codes and referrers safe from edits (members only change their names)
create or replace function private.profiles_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.first_name := private.clean_name(new.first_name);
  new.last_name := private.clean_name(new.last_name);
  new.updated_at := now();
  if new.referral_code is null then new.referral_code := private.new_referral_code(); end if;
  if tg_op = 'UPDATE' then
    new.referral_code := old.referral_code;
    if old.referred_by is not null then new.referred_by := old.referred_by; new.referred_at := old.referred_at; end if;
  end if;
  if new.referred_by = new.id then new.referred_by := null; new.referred_at := null; end if;
  return new;
end $$;

update public.profiles set referral_code = private.new_referral_code() where referral_code is null;

-- sign-up: an optional "ref" in the sign-up data links the new member to the code's owner
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_digits text;
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_first text;
  v_last text;
  v_ref uuid;
begin
  if coalesce(new.raw_app_meta_data->>'xg_kind', '') = 'provider' then
    return new;
  end if;
  if new.email is null or new.email !~ '^u[0-9]{8,15}@xgoplus\.online$' then
    if new.email ~* '@(p\.)?xgoplus\.online$' then
      raise exception 'invalid_signup';
    end if;
    return new; -- e.g. admin accounts made in the dashboard
  end if;
  v_digits := substring(new.email from '^u([0-9]{8,15})@');
  v_first := private.clean_name(v_meta->>'first_name');
  v_last := private.clean_name(v_meta->>'last_name');
  if coalesce(v_meta->>'phone', '') <> v_digits
     or length(v_first) not between 1 and 40
     or length(v_last) not between 1 and 40 then
    raise exception 'invalid_signup';
  end if;
  if private.referrals_on() and private.norm_code(v_meta->>'ref') is not null then
    select id into v_ref from public.profiles where referral_code = private.norm_code(v_meta->>'ref');   -- unknown code: ignored
  end if;
  insert into public.profiles (id, phone, first_name, last_name, referred_by, referred_at)
  values (new.id, v_digits, v_first, v_last, v_ref, case when v_ref is not null then now() end);
  return new;
end $$;

-- "Invited by Sara" on the sign-up form (first name only)
create or replace function public.check_referral_code(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  if not private.hit_rate_limit('refcheck', coalesce(private.client_ip(), 'x'), 60, 3600) then raise exception 'rate_limited'; end if;
  if not private.referrals_on() then return jsonb_build_object('valid', false); end if;
  select first_name into v_name from public.profiles where referral_code = private.norm_code(p_code);
  return jsonb_build_object('valid', v_name is not null, 'name', v_name);
end $$;

-- forgot the code at sign-up: add it within 7 days, before paying
create or replace function public.set_referrer(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_me record; v_ref record;
begin
  if v_uid is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.referrals_on() then raise exception 'referrals_off'; end if;
  if not private.hit_rate_limit('refset', v_uid::text, 10, 3600) then raise exception 'rate_limited'; end if;
  select * into v_me from public.profiles where id = v_uid for update;
  if v_me.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_me.referred_by is not null then raise exception 'referrer_already_set'; end if;
  if v_me.created_at < now() - interval '7 days'
     or exists (select 1 from public.membership_requests where user_id = v_uid and status = 'approved') then
    raise exception 'referrer_too_late';
  end if;
  select id, first_name, referred_by into v_ref from public.profiles where referral_code = private.norm_code(p_code);
  if v_ref.id is null then raise exception 'invalid_referral_code'; end if;
  if v_ref.id = v_uid or v_ref.referred_by = v_uid then raise exception 'invalid_referral_code'; end if;
  update public.profiles set referred_by = v_ref.id, referred_at = now() where id = v_uid;
  return jsonb_build_object('name', v_ref.first_name);
end $$;

-- ---------------------------------------------------------------------
-- 2) Wallet ledger
-- ---------------------------------------------------------------------
create table if not exists public.wallet_entries (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(12,2) not null check (amount <> 0),
  kind text not null check (kind in ('commission', 'membership', 'withdrawal', 'withdrawal_refund', 'adjustment')),
  request_id uuid,          -- membership request (commission source, or paid from wallet)
  withdrawal_id uuid,
  referred_user uuid,       -- whose payment earned this commission
  note text not null default '' check (length(note) <= 200),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists wallet_entries_user on public.wallet_entries (user_id, created_at desc);
create unique index if not exists wallet_commission_once on public.wallet_entries (request_id) where kind = 'commission';
alter table public.wallet_entries enable row level security;
revoke all on public.wallet_entries from anon, authenticated;   -- read through RPCs only

create or replace function private.wallet_balance(p_uid uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(amount), 0) from public.wallet_entries where user_id = p_uid
$$;

create or replace function private.commission_for(p_amount numeric) returns numeric
language sql stable security definer set search_path = '' as $$
  select round(coalesce(p_amount, 0) * least(greatest(private.setting_num('referral_commission_pct', 50), 0), 100) / 100)
$$;

-- membership_requests may now be paid from the wallet
alter table public.membership_requests drop constraint if exists membership_requests_method_check;
alter table public.membership_requests add constraint membership_requests_method_check check (method in ('instapay', 'vodafone', 'wallet'));

-- credit the referrer when a referred member's payment is approved
create or replace function private.credit_referral(p_request uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_r record; v_ref uuid; v_amt numeric;
begin
  if not private.referrals_on() then return; end if;
  select r.id, r.user_id, r.amount_egp, r.status into v_r from public.membership_requests r where r.id = p_request;
  if v_r.id is null or v_r.status <> 'approved' or coalesce(v_r.amount_egp, 0) <= 0 then return; end if;
  select referred_by into v_ref from public.profiles where id = v_r.user_id;
  if v_ref is null then return; end if;
  if not private.setting_bool('referral_on_renewals', false)
     and exists (select 1 from public.membership_requests x where x.user_id = v_r.user_id and x.status = 'approved'
                   and x.id <> v_r.id and coalesce(x.amount_egp, 0) > 0) then
    return;                                                   -- only the first paid year
  end if;
  v_amt := private.commission_for(v_r.amount_egp);
  if v_amt <= 0 then return; end if;
  insert into public.wallet_entries (user_id, amount, kind, request_id, referred_user, note)
  values (v_ref, v_amt, 'commission', v_r.id, v_r.user_id,
          (select 'Commission: ' || first_name || ' ' || left(last_name, 1) || '. joined' from public.profiles where id = v_r.user_id))
  on conflict do nothing;
end $$;

create or replace function private.approve_request(p_id uuid, p_by uuid, p_note text, p_sms bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare v_r record; v_current timestamptz; v_start timestamptz;
begin
  select * into v_r from public.membership_requests where id = p_id for update;
  if v_r.id is null or v_r.status <> 'pending' then return; end if;
  perform 1 from public.profiles where id = v_r.user_id for update;
  select max(expires_at) into v_current from public.memberships where user_id = v_r.user_id;
  v_start := greatest(now(), coalesce(v_current, now()));
  insert into public.memberships (user_id, starts_at, expires_at, list_price_egp, paid_egp, source, created_by)
  values (v_r.user_id, v_start, v_start + interval '1 year', v_r.amount_egp, v_r.amount_egp, 'payment', p_by);
  update public.membership_requests
     set status = 'approved', decided_at = now(), decided_by = p_by,
         admin_note = left(btrim(coalesce(p_note, '')), 500),
         matched_sms = coalesce(p_sms, matched_sms),
         auto_state = case when p_sms is not null then 'matched' else auto_state end
   where id = p_id;
  if p_sms is not null then
    update public.bank_sms set status = 'matched', request_id = p_id, matched_at = now() where id = p_sms;
  end if;
  perform private.credit_referral(p_id);
end $$;

-- pay (or renew) the yearly membership with the wallet balance
create or replace function public.pay_membership_with_wallet() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_price numeric := private.setting_num('membership_price_egp', 199);
  v_current timestamptz; v_bal numeric; v_id uuid;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid) then raise exception 'forbidden' using errcode = '42501'; end if;
  perform private.require_session();
  if private.payment_mode() <> 'active' then raise exception 'payments_unavailable'; end if;
  if not private.hit_rate_limit('walletpay', v_uid::text, 10, 3600) then raise exception 'rate_limited'; end if;
  perform 1 from public.profiles where id = v_uid for update;
  if exists (select 1 from public.membership_requests where user_id = v_uid and status = 'pending') then raise exception 'request_pending'; end if;
  select max(expires_at) into v_current from public.memberships where user_id = v_uid;
  if v_current is not null and v_current > now() + make_interval(days => private.setting_num('membership_renew_window_days', 30)::int) then
    raise exception 'already_active';
  end if;
  v_bal := private.wallet_balance(v_uid);
  if v_bal < v_price then raise exception 'wallet_insufficient'; end if;
  delete from public.membership_requests where user_id = v_uid and status = 'draft';
  insert into public.membership_requests (user_id, method, account_value, amount_egp, status, submitted_at)
  values (v_uid, 'wallet', 'XGo+ wallet', v_price, 'pending', now()) returning id into v_id;
  insert into public.wallet_entries (user_id, amount, kind, request_id, note)
  values (v_uid, -v_price, 'membership', v_id, 'Yearly membership paid from wallet');
  perform private.approve_request(v_id, null, 'Paid from wallet', null);
  return jsonb_build_object('status', 'approved', 'balance', private.wallet_balance(v_uid), 'membership', private.membership_state(v_uid));
end $$;
revoke all on function public.pay_membership_with_wallet() from public, anon;
grant execute on function public.pay_membership_with_wallet() to authenticated;

-- ---------------------------------------------------------------------
-- 3) Withdrawals
-- ---------------------------------------------------------------------
create table if not exists public.withdrawal_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  method text not null check (method in ('instapay', 'wallet')),
  phone text not null check (phone ~ '^01[0-9]{9}$'),
  status text not null default 'pending' check (status in ('pending', 'paid', 'rejected', 'cancelled')),
  due_at timestamptz not null,
  transfer_ref text not null default '' check (length(transfer_ref) <= 60),
  admin_note text not null default '' check (length(admin_note) <= 300),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid
);
create index if not exists withdrawal_requests_queue on public.withdrawal_requests (status, created_at);
create index if not exists withdrawal_requests_user on public.withdrawal_requests (user_id, created_at desc);
alter table public.withdrawal_requests enable row level security;
revoke all on public.withdrawal_requests from anon, authenticated;

create or replace function public.request_withdrawal(p_amount numeric, p_method text, p_phone text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_min numeric := private.setting_num('referral_min_withdrawal', 100);
  v_phone text := private.norm_eg_phone(private.ascii_digits(p_phone)); v_bal numeric; v_id uuid; v_due timestamptz;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid) then raise exception 'forbidden' using errcode = '42501'; end if;
  perform private.require_session();
  if not private.hit_rate_limit('withdraw', v_uid::text, 10, 3600) then raise exception 'rate_limited'; end if;
  if p_method not in ('instapay', 'wallet') then raise exception 'method_unavailable'; end if;
  if v_phone is null then raise exception 'payout_phone_required'; end if;
  if p_amount is null or p_amount <> trunc(p_amount) then raise exception 'withdrawal_whole_pounds'; end if;
  if p_amount < v_min then raise exception 'withdrawal_below_minimum'; end if;
  perform 1 from public.profiles where id = v_uid for update;
  if exists (select 1 from public.withdrawal_requests where user_id = v_uid and status = 'pending') then raise exception 'withdrawal_pending'; end if;
  v_bal := private.wallet_balance(v_uid);
  if p_amount > v_bal then raise exception 'wallet_insufficient'; end if;
  v_due := now() + make_interval(days => greatest(private.setting_num('referral_payout_days', 3)::int, 1));
  insert into public.withdrawal_requests (user_id, amount, method, phone, due_at)
  values (v_uid, p_amount, p_method, v_phone, v_due) returning id into v_id;
  insert into public.wallet_entries (user_id, amount, kind, withdrawal_id, note)
  values (v_uid, -p_amount, 'withdrawal', v_id, 'Cash withdrawal to ' || case when p_method = 'instapay' then 'InstaPay ' else 'wallet ' end || v_phone);
  return jsonb_build_object('id', v_id, 'due_at', v_due, 'balance', private.wallet_balance(v_uid));
end $$;
revoke all on function public.request_withdrawal(numeric, text, text) from public, anon;
grant execute on function public.request_withdrawal(numeric, text, text) to authenticated;

create or replace function public.cancel_withdrawal(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_w record;
begin
  if v_uid is null then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_w from public.withdrawal_requests where id = p_id and user_id = v_uid for update;
  if v_w.id is null then raise exception 'not_found'; end if;
  if v_w.status <> 'pending' then raise exception 'already_decided'; end if;
  update public.withdrawal_requests set status = 'cancelled', decided_at = now() where id = p_id;
  insert into public.wallet_entries (user_id, amount, kind, withdrawal_id, note)
  values (v_uid, v_w.amount, 'withdrawal_refund', p_id, 'Withdrawal cancelled — back in your wallet');
  return jsonb_build_object('balance', private.wallet_balance(v_uid));
end $$;
revoke all on function public.cancel_withdrawal(uuid) from public, anon;
grant execute on function public.cancel_withdrawal(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4) What a member sees
-- ---------------------------------------------------------------------
create or replace function public.my_referral_summary() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_p record; v_price numeric := private.setting_num('membership_price_egp', 199);
begin
  if v_uid is null then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_p from public.profiles where id = v_uid;
  if v_p.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'enabled', private.referrals_on(),
    'code', v_p.referral_code,
    'balance', private.wallet_balance(v_uid),
    'earned', coalesce((select sum(amount) from public.wallet_entries where user_id = v_uid and kind = 'commission'), 0),
    'withdrawn', coalesce((select sum(amount) from public.withdrawal_requests where user_id = v_uid and status = 'paid'), 0),
    'commission', private.commission_for(v_price),
    'commission_pct', private.setting_num('referral_commission_pct', 50),
    'price', v_price,
    'payment_mode', private.payment_mode(),
    'min_withdrawal', private.setting_num('referral_min_withdrawal', 100),
    'payout_days', private.setting_num('referral_payout_days', 3),
    'joined', (select count(*) from public.profiles where referred_by = v_uid),
    'paid', (select count(distinct referred_user) from public.wallet_entries where user_id = v_uid and kind = 'commission'),
    'referred_by', (select first_name from public.profiles where id = v_p.referred_by),
    'can_set_referrer', v_p.referred_by is null and v_p.created_at > now() - interval '7 days'
       and not exists (select 1 from public.membership_requests where user_id = v_uid and status = 'approved'),
    'friends', coalesce((select jsonb_agg(f order by f->>'joined_at' desc) from (
        select jsonb_build_object('name', p.first_name || ' ' || left(p.last_name, 1) || '.', 'joined_at', coalesce(p.referred_at, p.created_at),
               'earned', coalesce((select sum(e.amount) from public.wallet_entries e where e.user_id = v_uid and e.kind = 'commission' and e.referred_user = p.id), 0)) as f
        from public.profiles p where p.referred_by = v_uid order by coalesce(p.referred_at, p.created_at) desc limit 100) x), '[]'::jsonb),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('amount', e.amount, 'kind', e.kind, 'note', e.note, 'at', e.created_at) order by e.id desc)
        from (select * from public.wallet_entries where user_id = v_uid order by id desc limit 50) e), '[]'::jsonb),
    'withdrawals', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'amount', w.amount, 'method', w.method, 'phone', w.phone,
        'status', w.status, 'created_at', w.created_at, 'due_at', w.due_at, 'decided_at', w.decided_at,
        'transfer_ref', w.transfer_ref, 'note', w.admin_note, 'overdue', w.status = 'pending' and w.due_at < now()) order by w.created_at desc)
        from (select * from public.withdrawal_requests where user_id = v_uid order by created_at desc limit 20) w), '[]'::jsonb));
end $$;
revoke all on function public.my_referral_summary() from public, anon;
grant execute on function public.my_referral_summary() to authenticated;

-- public numbers for the home banner / invite page (no personal data)
create or replace function public.referral_offer() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('enabled', private.referrals_on(),
    'commission', private.commission_for(private.setting_num('membership_price_egp', 199)),
    'commission_pct', private.setting_num('referral_commission_pct', 50),
    'price', private.setting_num('membership_price_egp', 199),
    'min_withdrawal', private.setting_num('referral_min_withdrawal', 100),
    'payout_days', private.setting_num('referral_payout_days', 3))
$$;
revoke all on function public.referral_offer() from public;
grant execute on function public.referral_offer() to anon, authenticated;

-- ---------------------------------------------------------------------
-- 5) Admin
-- ---------------------------------------------------------------------
create or replace function public.admin_referral_overview() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_referral_overview') then return null; end if;
  return jsonb_build_object(
    'referred_members', (select count(*) from public.profiles where referred_by is not null),
    'paid_referrals', (select count(*) from public.wallet_entries where kind = 'commission'),
    'commissions_total', coalesce((select sum(amount) from public.wallet_entries where kind = 'commission'), 0),
    'balances_total', coalesce((select sum(amount) from public.wallet_entries), 0),
    'paid_out', coalesce((select sum(amount) from public.withdrawal_requests where status = 'paid'), 0),
    'pending_count', (select count(*) from public.withdrawal_requests where status = 'pending'),
    'pending_total', coalesce((select sum(amount) from public.withdrawal_requests where status = 'pending'), 0),
    'overdue_count', (select count(*) from public.withdrawal_requests where status = 'pending' and due_at < now()),
    'top', coalesce((select jsonb_agg(t order by (t->>'earned')::numeric desc, (t->>'joined')::int desc) from (
        select jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'phone', p.phone, 'code', p.referral_code,
               'joined', (select count(*) from public.profiles c where c.referred_by = p.id),
               'paid', (select count(*) from public.wallet_entries e where e.user_id = p.id and e.kind = 'commission'),
               'earned', coalesce((select sum(e.amount) from public.wallet_entries e where e.user_id = p.id and e.kind = 'commission'), 0),
               'balance', private.wallet_balance(p.id)) as t
        from public.profiles p
        where exists (select 1 from public.profiles c where c.referred_by = p.id)
           or exists (select 1 from public.wallet_entries e where e.user_id = p.id)
        order by (select count(*) from public.wallet_entries e where e.user_id = p.id and e.kind = 'commission') desc,
                 (select count(*) from public.profiles c where c.referred_by = p.id) desc
        limit 25) x), '[]'::jsonb));
end $$;

create or replace function public.admin_list_withdrawals(p_status text default 'pending', p_limit int default 30, p_offset int default 0)
returns table (id uuid, user_id uuid, member_name text, member_phone text, amount numeric, method text, phone text, status text,
               created_at timestamptz, due_at timestamptz, decided_at timestamptz, transfer_ref text, admin_note text,
               balance numeric, referrals_paid bigint, total bigint)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_list_withdrawals') then return; end if;
  return query
    select w.id, w.user_id, p.first_name || ' ' || p.last_name, p.phone, w.amount, w.method, w.phone, w.status,
           w.created_at, w.due_at, w.decided_at, w.transfer_ref, w.admin_note, private.wallet_balance(w.user_id),
           (select count(*) from public.wallet_entries e where e.user_id = w.user_id and e.kind = 'commission'),
           count(*) over ()
    from public.withdrawal_requests w join public.profiles p on p.id = w.user_id
    where p_status is null or p_status = '' or w.status = p_status
    order by (w.status = 'pending') desc, case when w.status = 'pending' then w.created_at end asc, w.created_at desc
    limit least(greatest(coalesce(p_limit, 30), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

create or replace function public.admin_decide_withdrawal(p_id uuid, p_paid boolean, p_transfer_ref text default '', p_note text default '') returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_w record;
begin
  if private.admin_denied('admin_decide_withdrawal') then return; end if;
  select * into v_w from public.withdrawal_requests where id = p_id for update;
  if v_w.id is null then raise exception 'not_found'; end if;
  if v_w.status <> 'pending' then raise exception 'already_decided'; end if;
  update public.withdrawal_requests
     set status = case when p_paid then 'paid' else 'rejected' end, decided_at = now(), decided_by = auth.uid(),
         transfer_ref = left(btrim(regexp_replace(coalesce(p_transfer_ref, ''), '[[:cntrl:]<>]', '', 'g')), 60),
         admin_note = left(btrim(regexp_replace(coalesce(p_note, ''), '[[:cntrl:]<>]', '', 'g')), 300)
   where id = p_id;
  if not p_paid then
    insert into public.wallet_entries (user_id, amount, kind, withdrawal_id, note, created_by)
    values (v_w.user_id, v_w.amount, 'withdrawal_refund', p_id, left('Withdrawal not paid — back in your wallet' ||
            case when btrim(coalesce(p_note, '')) <> '' then ': ' || btrim(p_note) else '' end, 200), auth.uid());
  end if;
end $$;

create or replace function public.admin_member_wallet(p_user uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_member_wallet') then return null; end if;
  return jsonb_build_object(
    'code', (select referral_code from public.profiles where id = p_user),
    'referred_by', (select r.first_name || ' ' || r.last_name || ' (' || r.phone || ')' from public.profiles m join public.profiles r on r.id = m.referred_by where m.id = p_user),
    'balance', private.wallet_balance(p_user),
    'friends', coalesce((select jsonb_agg(jsonb_build_object('name', c.first_name || ' ' || c.last_name, 'phone', c.phone, 'joined_at', c.created_at,
                 'paid', exists (select 1 from public.wallet_entries e where e.user_id = p_user and e.kind = 'commission' and e.referred_user = c.id)) order by c.created_at desc)
               from public.profiles c where c.referred_by = p_user), '[]'::jsonb),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('amount', e.amount, 'kind', e.kind, 'note', e.note, 'at', e.created_at) order by e.id desc)
               from (select * from public.wallet_entries where user_id = p_user order by id desc limit 100) e), '[]'::jsonb));
end $$;

-- manual correction (bonus, chargeback…) — always logged with a note
create or replace function public.admin_wallet_adjust(p_user uuid, p_amount numeric, p_note text) returns numeric
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_wallet_adjust') then return null; end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 100000 then raise exception 'invalid_amount'; end if;
  if length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'note_required'; end if;
  perform 1 from public.profiles where id = p_user for update;
  if not found then raise exception 'not_found'; end if;
  if private.wallet_balance(p_user) + p_amount < 0 then raise exception 'wallet_insufficient'; end if;
  insert into public.wallet_entries (user_id, amount, kind, note, created_by)
  values (p_user, p_amount, 'adjustment', left(btrim(p_note), 200), auth.uid());
  return private.wallet_balance(p_user);
end $$;

revoke all on function public.admin_referral_overview() from public;
revoke all on function public.admin_list_withdrawals(text, int, int) from public;
revoke all on function public.admin_decide_withdrawal(uuid, boolean, text, text) from public;
revoke all on function public.admin_member_wallet(uuid) from public;
revoke all on function public.admin_wallet_adjust(uuid, numeric, text) from public;
revoke all on function public.check_referral_code(text) from public;
revoke all on function public.set_referrer(text) from public, anon;
grant execute on function public.admin_referral_overview() to anon, authenticated;
grant execute on function public.admin_list_withdrawals(text, int, int) to anon, authenticated;
grant execute on function public.admin_decide_withdrawal(uuid, boolean, text, text) to anon, authenticated;
grant execute on function public.admin_member_wallet(uuid) to anon, authenticated;
grant execute on function public.admin_wallet_adjust(uuid, numeric, text) to anon, authenticated;
grant execute on function public.check_referral_code(text) to anon, authenticated;
grant execute on function public.set_referrer(text) to authenticated;

create or replace function public.schema_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'version', 18,
    'm005', to_regclass('public.categories') is not null,
    'm006', to_regclass('public.complaints') is not null,
    'm007', to_regclass('public.areas') is not null,
    'm008', to_regclass('public.membership_requests') is not null,
    'm009', to_regclass('public.trials') is not null,
    'm010', to_regprocedure('public.home_feed(uuid, integer, integer, integer)') is not null,
    'm011', to_regclass('public.branches') is not null,
    'm012', to_regclass('public.discount_rules') is not null,
    'm013', to_regclass('public.explore_ads') is not null,
    'm014', to_regclass('public.bank_sms') is not null,
    'm015', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'discount_rules' and column_name = 'value_type'),
    'm016', position('coalesce(p_rows, 100)' in pg_get_functiondef('public.home_feed(uuid, integer, integer, integer)'::regprocedure)) > 0,
    'm017', to_regprocedure('private.mask_sms(text)') is not null,
    'm018', to_regclass('public.wallet_entries') is not null)
$$;
