-- =====================================================================
-- XGo Plus — 014 automatic payment confirmation (InstaPay + mobile wallets)
--
-- How it works
--  * An Android phone with the receiving SIM runs the "XGo+ SMS Listener"
--    app. It is paired once with a short code from Admin → Payments and
--    then forwards incoming money SMS (raw text) to sms_ingest().
--  * The database parses each SMS (so parsers can be fixed without
--    updating the app):  InstaPay → 12-digit reference + amount,
--    wallet → sender phone + amount.
--  * Customers paying with InstaPay upload the receipt screenshot and the
--    12-digit reference (read by OCR in the browser, editable); wallet
--    payers type the number they paid from.
--  * Reconciliation runs when either side arrives: exact reference
--    (InstaPay) or phone + time window (wallet), amount >= price, each SMS
--    and each reference used once, approval atomic. No match = stays
--    pending; after 24 h it is flagged for manual review. Never rejected
--    automatically.
--  * Only SMS from bank/wallet sender IDs count: a name (letters) or a short
--    code (3–6 digits) — people's full numbers can't fake a payment — or the
--    admin's allow-list when one is set.
--  * Switch: settings.autopay_enabled (Admin → Payments). Off = manual
--    approval exactly as before. Per account: payment_accounts.auto_confirm
--    = "this account's SMS arrive on the listener phone".
-- Idempotent. Run after 013.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Accounts + requests
-- ---------------------------------------------------------------------
alter table public.payment_accounts add column if not exists auto_confirm boolean not null default false;
grant select (auto_confirm) on public.payment_accounts to authenticated;
grant insert (auto_confirm), update (auto_confirm) on public.payment_accounts to authenticated;

alter table public.membership_requests add column if not exists pay_ref text check (pay_ref is null or pay_ref ~ '^[0-9]{12}$');
alter table public.membership_requests add column if not exists ocr_ref text check (ocr_ref is null or ocr_ref ~ '^[0-9]{12}$');
alter table public.membership_requests add column if not exists payer_phone text check (payer_phone is null or payer_phone ~ '^01[0-9]{9}$');
alter table public.membership_requests add column if not exists auto boolean not null default false;
alter table public.membership_requests add column if not exists auto_state text
  check (auto_state is null or auto_state in ('awaiting_bank', 'matched', 'manual_review'));
alter table public.membership_requests add column if not exists matched_sms bigint;
-- one reference can pay for one membership only
create unique index if not exists membership_requests_ref_once on public.membership_requests (pay_ref)
  where pay_ref is not null and status in ('pending', 'approved');

create or replace function private.autopay_on() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.setting_bool('autopay_enabled', false) and private.payment_mode() = 'active'
$$;

create or replace function private.norm_eg_phone(p text) returns text
language sql immutable set search_path = '' as $$
  select case
    when d ~ '^01[0-9]{9}$' then d
    when d ~ '^201[0-9]{9}$' then substr(d, 2)
    when d ~ '^00201[0-9]{9}$' then substr(d, 4)
    when d ~ '^1[0-9]{9}$' then '0' || d
  end
  from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) x
$$;

-- ---------------------------------------------------------------------
-- 2) Listener devices (paired phones)
-- ---------------------------------------------------------------------
create table if not exists private.sms_devices (
  id uuid primary key default gen_random_uuid(),
  name text not null default '' check (length(name) <= 60),
  token_hash text unique,
  pair_code_hash text unique,
  pair_expires_at timestamptz,
  created_at timestamptz not null default now(),
  paired_at timestamptz,
  last_seen_at timestamptz,
  last_info text not null default '' check (length(last_info) <= 200),
  sms_count int not null default 0,
  revoked_at timestamptz
);

create or replace function private.sha(p text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(coalesce(p, ''), 'sha256'), 'hex')
$$;

create or replace function private.device_for(p_token text) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from private.sms_devices
  where token_hash = private.sha(p_token) and revoked_at is null and length(coalesce(p_token, '')) >= 32
$$;

-- ---------------------------------------------------------------------
-- 3) Incoming SMS log + parser
-- ---------------------------------------------------------------------
create table if not exists public.bank_sms (
  id bigint generated always as identity primary key,
  device_id uuid,
  sender text not null default '' check (length(sender) <= 40),
  body text not null check (length(body) <= 1000),
  body_hash text not null unique,
  sms_at timestamptz,
  received_at timestamptz not null default now(),
  kind text not null default 'other' check (kind in ('instapay', 'wallet', 'other')),
  amount numeric(12,2),
  reference text,
  from_phone text,
  from_name text,
  trusted boolean not null default false,
  status text not null default 'unmatched' check (status in ('unmatched', 'matched', 'ignored')),
  request_id uuid unique,
  matched_at timestamptz
);
create unique index if not exists bank_sms_ref_once on public.bank_sms (reference) where reference is not null and kind = 'instapay';
create index if not exists bank_sms_open on public.bank_sms (kind, status, received_at desc);
create index if not exists bank_sms_phone on public.bank_sms (from_phone) where status = 'unmatched';
alter table public.bank_sms enable row level security;
revoke all on public.bank_sms from anon, authenticated;   -- admin RPCs only

-- Arabic-Indic digits → ASCII, thousands separators out
create or replace function private.ascii_digits(p text) returns text
language sql immutable set search_path = '' as $$
  select translate(coalesce(p, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹٫', '01234567890123456789.')
$$;

create or replace function private.parse_bank_sms(p_body text)
returns table (kind text, amount numeric, reference text, from_phone text, from_name text)
language plpgsql immutable set search_path = '' as $$
declare
  b text := regexp_replace(private.ascii_digits(p_body), '\s+', ' ', 'g');
  v_amt text; v_ref text; v_phone text; v_name text;
  v_in boolean; v_out boolean;
begin
  -- incoming money only
  v_in := b ~* '(إضافة|اضافة|إيداع|ايداع|استلام|استقبال|تم تحويل .* إليك|received|credited|deposited|incoming)';
  v_out := b ~* '(خصم|سحب|تم تحويل مبلغ .* إلى|تم دفع|debited|withdraw|sent to|you sent|purchase)';
  v_amt := coalesce(
    (regexp_match(b, '(?:بمبلغ|مبلغ|قيمة|بقيمة)\s*:?\s*(?:EGP|LE|ج\.?م\.?)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)', 'i'))[1],
    (regexp_match(b, '(?:EGP|LE)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)', 'i'))[1],
    (regexp_match(b, '([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:EGP|LE|جم|جنيه|ج\.م)', 'i'))[1]);
  v_ref := coalesce(
    (regexp_match(b, '(?:رقم\s*(?:ال)?مرجع(?:ي)?|الرقم\s*المرجعي|مرجع)\s*:?\s*([0-9]{8,20})'))[1],
    (regexp_match(b, '(?:ref(?:erence)?(?:\s*(?:no|number|#))?\.?)\s*:?\s*([0-9]{8,20})', 'i'))[1]);
  v_phone := (regexp_match(b, '(?:من|from)\s*(?:رقم\s*)?(?:حساب|محفظة|المحفظة|wallet|number|mobile)?\s*(?:رقم\s*)?:?\s*((?:\+?20|0020)?1[0-9]{9}|01[0-9]{9})', 'i'))[1];
  -- sender name: the words after "من" (bank) or "باسم" (wallet), cut at the next keyword
  v_name := (regexp_match(b, '(?:جم|جنيه|EGP)\s+من\s+([^0-9]+)'))[1];
  if v_name is null then v_name := (regexp_match(b, 'باسم\s+([^0-9.،;؛]+)'))[1]; end if;
  v_name := nullif(btrim(regexp_replace(coalesce(v_name, ''), '\s*(رقم|مرجع|يوم|بتاريخ|استخدم|رصيد|للمزيد|الساعة).*$', '')), '');

  amount := nullif(replace(coalesce(v_amt, ''), ',', ''), '')::numeric;
  reference := case when v_ref ~ '^[0-9]{12}$' then v_ref end;
  from_phone := private.norm_eg_phone(v_phone);
  from_name := left(v_name, 80);
  kind := case
    when not v_in or v_out or amount is null then 'other'
    when reference is not null then 'instapay'
    when from_phone is not null then 'wallet'
    else 'other' end;
  return next;
end $$;

-- ---------------------------------------------------------------------
-- 4) Approval + reconciliation
-- ---------------------------------------------------------------------
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
end $$;

-- which unclaimed SMS pays this request (null = none / ambiguous)
create or replace function private.sms_for_request(p_id uuid) returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare v_r record; v_ids bigint[];
begin
  select * into v_r from public.membership_requests where id = p_id;
  if v_r.id is null or v_r.status <> 'pending' or not v_r.auto then return null; end if;
  if v_r.method = 'instapay' then
    if v_r.pay_ref is null or (v_r.ocr_ref is not null and v_r.ocr_ref <> v_r.pay_ref) then return null; end if;
    select array_agg(s.id order by s.id) into v_ids from public.bank_sms s
     where s.kind = 'instapay' and s.status = 'unmatched' and s.trusted
       and s.reference = v_r.pay_ref and s.amount >= v_r.amount_egp
       and coalesce(s.sms_at, s.received_at) > v_r.created_at - interval '3 days';
  else
    if v_r.payer_phone is null then return null; end if;
    select array_agg(s.id order by coalesce(s.sms_at, s.received_at), s.id) into v_ids from public.bank_sms s
     where s.kind = 'wallet' and s.status = 'unmatched' and s.trusted
       and s.from_phone = v_r.payer_phone and s.amount >= v_r.amount_egp
       and coalesce(s.sms_at, s.received_at) > v_r.created_at - interval '2 hours'
       and coalesce(s.sms_at, s.received_at) < coalesce(v_r.submitted_at, now()) + interval '3 days';
  end if;
  return v_ids[1];
end $$;

-- the other way round: which pending request does this SMS pay (exactly one, else null)
create or replace function private.request_for_sms(p_sms bigint) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_s record; v_ids uuid[];
begin
  select * into v_s from public.bank_sms where id = p_sms;
  if v_s.id is null or v_s.status <> 'unmatched' or not v_s.trusted then return null; end if;
  select array_agg(r.id) into v_ids from public.membership_requests r
   where r.status = 'pending' and r.auto and v_s.amount >= r.amount_egp
     and ((v_s.kind = 'instapay' and r.method = 'instapay' and r.pay_ref = v_s.reference
           and (r.ocr_ref is null or r.ocr_ref = r.pay_ref) and coalesce(v_s.sms_at, v_s.received_at) > r.created_at - interval '3 days')
       or (v_s.kind = 'wallet' and r.method = 'vodafone' and r.payer_phone = v_s.from_phone
           and coalesce(v_s.sms_at, v_s.received_at) > r.created_at - interval '2 hours'
           and coalesce(v_s.sms_at, v_s.received_at) < coalesce(r.submitted_at, now()) + interval '3 days'));
  if coalesce(array_length(v_ids, 1), 0) <> 1 then return null; end if;   -- none or ambiguous → admin
  return v_ids[1];
end $$;

create or replace function private.try_match_request(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_sms bigint;
begin
  if not private.autopay_on() then return false; end if;
  perform 1 from public.membership_requests where id = p_id for update;
  v_sms := private.sms_for_request(p_id);
  if v_sms is null then return false; end if;
  perform 1 from public.bank_sms where id = v_sms and status = 'unmatched' for update;
  if not found or private.request_for_sms(v_sms) is distinct from p_id then return false; end if;
  perform private.approve_request(p_id, null, 'Auto-approved: matched bank SMS #' || v_sms, v_sms);
  return true;
end $$;

create or replace function private.try_match_sms(p_sms bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_req uuid;
begin
  if not private.autopay_on() then return false; end if;
  v_req := private.request_for_sms(p_sms);   -- locks are taken request-first inside try_match_request
  if v_req is null then return false; end if;
  return private.try_match_request(v_req);
end $$;

-- ---------------------------------------------------------------------
-- 5) Listener API (called by the Android app with the anon key)
-- ---------------------------------------------------------------------
create or replace function public.sms_pair(p_code text, p_name text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_token text; v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  if not private.hit_rate_limit('smspair', coalesce(private.client_ip(), 'x'), 10, 3600) then raise exception 'rate_limited'; end if;
  select id into v_id from private.sms_devices
   where pair_code_hash = private.sha(v_code) and pair_expires_at > now() and revoked_at is null for update;
  if v_id is null then
    perform private.flag_ip('sms_pair_fail', left(v_code, 12), 1);
    raise exception 'invalid_code';
  end if;
  v_token := 'xgsms_' || encode(extensions.gen_random_bytes(24), 'hex');
  update private.sms_devices set token_hash = private.sha(v_token), pair_code_hash = null, pair_expires_at = null,
         paired_at = now(), last_seen_at = now(),
         name = case when name = '' then left(btrim(coalesce(p_name, '')), 60) else name end
   where id = v_id;
  return jsonb_build_object('token', v_token, 'device_id', v_id);
end $$;

create or replace function public.sms_heartbeat(p_token text, p_info text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_dev uuid := private.device_for(p_token);
begin
  if v_dev is null then raise exception 'device_revoked'; end if;
  if not private.hit_rate_limit('smsbeat', v_dev::text, 120, 3600) then raise exception 'rate_limited'; end if;
  update private.sms_devices set last_seen_at = now(), last_info = left(coalesce(p_info, ''), 200) where id = v_dev;
  return jsonb_build_object('enabled', private.autopay_on(), 'server_time', now());
end $$;

create or replace function public.sms_ingest(p_token text, p_sender text, p_body text, p_sms_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dev uuid := private.device_for(p_token);
  v_body text := left(btrim(coalesce(p_body, '')), 1000);
  v_sender text := left(btrim(regexp_replace(coalesce(p_sender, ''), '[[:cntrl:]]', '', 'g')), 40);
  v_p record; v_id bigint; v_trusted boolean; v_allow jsonb; v_matched boolean := false;
begin
  if v_dev is null then raise exception 'device_revoked'; end if;
  if not private.hit_rate_limit('smsin', v_dev::text, 600, 3600) then raise exception 'rate_limited'; end if;
  if length(v_body) = 0 then return jsonb_build_object('stored', false); end if;
  update private.sms_devices set last_seen_at = now(), sms_count = sms_count + 1 where id = v_dev;
  select * into v_p from private.parse_bank_sms(v_body);
  v_allow := (select data->'autopay_senders' from public.settings where id = 1);
  v_trusted := case
    when jsonb_typeof(v_allow) = 'array' and jsonb_array_length(v_allow) > 0
      then exists (select 1 from jsonb_array_elements_text(v_allow) a where lower(btrim(a)) = lower(v_sender))
    else v_sender ~ '[A-Za-z]' or v_sender ~ '^[0-9]{3,6}$' end;   -- bank/wallet IDs have letters or are short codes; people have full numbers
  insert into public.bank_sms (device_id, sender, body, body_hash, sms_at, kind, amount, reference, from_phone, from_name, trusted, status)
  values (v_dev, v_sender, v_body, private.sha(v_sender || '|' || v_body || '|' || coalesce(p_sms_at::text, '')),
          least(coalesce(p_sms_at, now()), now()), v_p.kind, v_p.amount, v_p.reference, v_p.from_phone, v_p.from_name, v_trusted,
          case when v_p.kind = 'other' then 'ignored' else 'unmatched' end)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then return jsonb_build_object('stored', false, 'duplicate', true); end if;
  if v_p.kind <> 'other' then v_matched := private.try_match_sms(v_id); end if;
  return jsonb_build_object('stored', true, 'kind', v_p.kind, 'matched', v_matched);
end $$;

revoke all on function public.sms_pair(text, text) from public;
revoke all on function public.sms_heartbeat(text, text) from public;
revoke all on function public.sms_ingest(text, text, text, timestamptz) from public;
grant execute on function public.sms_pair(text, text) to anon, authenticated;
grant execute on function public.sms_heartbeat(text, text) to anon, authenticated;
grant execute on function public.sms_ingest(text, text, text, timestamptz) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 6) Customer side
-- ---------------------------------------------------------------------
create or replace function public.payment_options() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'mode', private.payment_mode(),
    'price', private.setting_num('membership_price_egp', 199),
    'autopay', private.autopay_on(),
    'methods', coalesce((select jsonb_agg(distinct method) from public.payment_accounts where is_active), '[]'::jsonb))
$$;
revoke all on function public.payment_options() from public;
grant execute on function public.payment_options() to anon, authenticated;

-- With autopay on, rotate among the accounts the listener phone receives (if any)
create or replace function public.start_membership_payment(p_method text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_current timestamptz;
  v_every int := greatest(private.setting_num('payment_rotate_every', 5)::int, 1);
  v_price numeric := private.setting_num('membership_price_egp', 199);
  v_auto_only boolean;
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
  v_auto_only := private.autopay_on()
    and exists (select 1 from public.payment_accounts where method = p_method and is_active and auto_confirm);
  select count(*) into v_cnt from public.payment_accounts where method = p_method and is_active and (auto_confirm or not v_auto_only);
  if v_cnt = 0 then raise exception 'method_unavailable'; end if;
  select coalesce((select n from private.payment_counters where method = p_method), 0) into v_n;
  select id, value, pay_link, auto_confirm into v_acc from public.payment_accounts
   where method = p_method and is_active and (auto_confirm or not v_auto_only)
   order by sort_order, created_at, id offset ((v_n / v_every) % v_cnt) limit 1;
  update public.membership_requests set method = p_method, account_id = v_acc.id, account_value = v_acc.value,
         amount_egp = v_price, created_at = now()
   where user_id = v_uid and status = 'draft' returning id into v_id;
  if v_id is null then
    insert into public.membership_requests (user_id, method, account_id, account_value, amount_egp)
    values (v_uid, p_method, v_acc.id, v_acc.value, v_price) returning id into v_id;
  end if;
  return jsonb_build_object('request_id', v_id, 'method', p_method, 'account_value', v_acc.value,
                            'pay_link', v_acc.pay_link, 'amount', v_price,
                            'auto', private.autopay_on() and coalesce(v_acc.auto_confirm, false));
end $$;
revoke all on function public.start_membership_payment(text) from public, anon;
grant execute on function public.start_membership_payment(text) to authenticated;

-- Submit with the transfer details. InstaPay: screenshot + 12-digit reference.
-- Wallet: number paid from (+ screenshot unless autopay handles it).
create or replace function public.submit_payment(
  p_request uuid, p_proof_path text default null, p_ref text default null,
  p_payer_phone text default null, p_ocr_ref text default null, p_sender text default ''
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_r record; v_auto boolean; v_has_proof boolean;
  v_ref text := nullif(regexp_replace(private.ascii_digits(p_ref), '[^0-9]', '', 'g'), '');
  v_ocr text := nullif(regexp_replace(private.ascii_digits(p_ocr_ref), '[^0-9]', '', 'g'), '');
  v_phone text := private.norm_eg_phone(private.ascii_digits(p_payer_phone));
  v_matched boolean := false;
begin
  if v_uid is null then raise exception 'forbidden' using errcode = '42501'; end if;
  perform private.require_session();
  if private.payment_mode() <> 'active' then raise exception 'payments_unavailable'; end if;
  if not private.hit_rate_limit('paysubmit', v_uid::text, 15, 3600) then raise exception 'rate_limited'; end if;
  select r.*, coalesce(a.auto_confirm, false) as acc_auto into v_r
    from public.membership_requests r left join public.payment_accounts a on a.id = r.account_id
   where r.id = p_request and r.user_id = v_uid and r.status = 'draft' for update of r;
  if v_r.id is null then raise exception 'not_found'; end if;
  v_auto := private.autopay_on() and v_r.acc_auto;
  v_has_proof := coalesce(p_proof_path, '') ~ ('^' || v_uid::text || '/' || p_request::text || '-[A-Za-z0-9]{4,20}\.(jpg|jpeg|png|webp)$')
                 and exists (select 1 from storage.objects o where o.bucket_id = 'proofs' and o.name = p_proof_path);
  if v_ocr is not null and v_ocr !~ '^[0-9]{12}$' then v_ocr := null; end if;

  if v_r.method = 'instapay' then
    if not v_has_proof then raise exception 'proof_required'; end if;
    if v_auto and (v_ref is null or v_ref !~ '^[0-9]{12}$') then raise exception 'reference_required'; end if;
    if v_ref is not null and v_ref !~ '^[0-9]{12}$' then raise exception 'reference_invalid'; end if;
    if v_ref is not null and (exists (select 1 from public.membership_requests x where x.pay_ref = v_ref and x.status in ('pending', 'approved'))
                              or exists (select 1 from public.bank_sms s where s.reference = v_ref and s.status = 'matched')) then
      raise exception 'reference_used';
    end if;
  else
    if v_auto and v_phone is null then raise exception 'payer_phone_required'; end if;
    if not v_auto and not v_has_proof then raise exception 'proof_required'; end if;
  end if;

  update public.membership_requests
     set proof_path = case when v_has_proof then p_proof_path end, status = 'pending', submitted_at = now(),
         sender_info = left(btrim(regexp_replace(coalesce(p_sender, ''), '[[:cntrl:]<>]', '', 'g')), 120),
         pay_ref = case when v_r.method = 'instapay' then v_ref end,
         ocr_ref = case when v_r.method = 'instapay' then v_ocr end,
         payer_phone = case when v_r.method = 'vodafone' then v_phone end,
         auto = v_auto, auto_state = case when v_auto then 'awaiting_bank' end
   where id = p_request;
  insert into private.payment_counters as c (method, n) values (v_r.method, 1)
  on conflict (method) do update set n = c.n + 1;
  update public.payment_accounts set uses_count = uses_count + 1 where id = v_r.account_id;
  if v_auto then v_matched := private.try_match_request(p_request); end if;
  return jsonb_build_object('status', case when v_matched then 'approved' else 'pending' end, 'auto', v_auto,
                            'membership', case when v_matched then private.membership_state(v_uid) end);
end $$;
revoke all on function public.submit_payment(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.submit_payment(uuid, text, text, text, text, text) to authenticated;

-- old clients keep working (manual path)
create or replace function public.submit_membership_request(p_request uuid, p_proof_path text, p_sender text default '') returns jsonb
language sql security definer set search_path = '' as $$
  select public.submit_payment(p_request, p_proof_path, null, null, null, p_sender)
$$;

create or replace function public.my_membership_request() returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(r) from (
    select id, method, account_value, amount_egp, status, admin_note, created_at, submitted_at, decided_at,
           auto, pay_ref, payer_phone,
           case when status = 'pending' and auto and submitted_at < now() - interval '24 hours' then 'manual_review'
                else auto_state end as auto_state
    from public.membership_requests where user_id = auth.uid() and status <> 'cancelled'
    order by created_at desc limit 1) r
$$;
revoke all on function public.my_membership_request() from public, anon;
grant execute on function public.my_membership_request() to authenticated;

-- ---------------------------------------------------------------------
-- 7) Admin
-- ---------------------------------------------------------------------
create or replace function public.admin_decide_request(p_id uuid, p_approve boolean, p_note text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_r record;
begin
  if private.admin_denied('admin_decide_request') then return null; end if;
  select * into v_r from public.membership_requests where id = p_id for update;
  if v_r.id is null then raise exception 'not_found'; end if;
  if v_r.status <> 'pending' then raise exception 'already_decided'; end if;
  if p_approve then
    perform private.approve_request(p_id, auth.uid(), p_note, null);
  else
    update public.membership_requests set status = 'rejected', admin_note = left(btrim(coalesce(p_note, '')), 500),
           decided_at = now(), decided_by = auth.uid() where id = p_id;
  end if;
  return private.membership_state(v_r.user_id);
end $$;

drop function if exists public.admin_list_requests(text, int, int);
create or replace function public.admin_list_requests(p_status text default 'pending', p_limit int default 30, p_offset int default 0)
returns table (id uuid, created_at timestamptz, submitted_at timestamptz, decided_at timestamptz, status text, method text,
               account_value text, amount_egp numeric, proof_path text, sender_info text, admin_note text,
               user_id uuid, member_name text, member_phone text, member_status text,
               auto boolean, auto_state text, pay_ref text, ocr_ref text, payer_phone text, matched_sms bigint,
               candidate_sms bigint, total bigint)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_list_requests') then return; end if;
  return query
    select r.id, r.created_at, r.submitted_at, r.decided_at, r.status, r.method, r.account_value, r.amount_egp,
           r.proof_path, r.sender_info, r.admin_note, r.user_id, p.first_name || ' ' || p.last_name, p.phone,
           private.membership_state(r.user_id)->>'status',
           r.auto,
           case when r.status = 'pending' and r.auto and r.submitted_at < now() - interval '24 hours' then 'manual_review' else r.auto_state end,
           r.pay_ref, r.ocr_ref, r.payer_phone, r.matched_sms,
           case when r.status = 'pending' then (
             select s.id from public.bank_sms s
              where s.status = 'unmatched' and s.amount >= r.amount_egp
                and ((r.method = 'instapay' and s.kind = 'instapay' and s.reference = r.pay_ref)
                  or (r.method = 'vodafone' and s.kind = 'wallet' and s.from_phone = r.payer_phone
                      and coalesce(s.sms_at, s.received_at) > r.created_at - interval '2 hours'))
              order by coalesce(s.sms_at, s.received_at) limit 1) end,
           count(*) over ()
    from public.membership_requests r join public.profiles p on p.id = r.user_id
    where r.status <> 'draft' and (p_status is null or p_status = '' or r.status = p_status)
    order by (r.status = 'pending') desc,
             (r.status = 'pending' and r.auto and r.submitted_at < now() - interval '24 hours') desc,
             coalesce(r.submitted_at, r.created_at) asc, r.id
    limit least(greatest(coalesce(p_limit, 30), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;
revoke all on function public.admin_list_requests(text, int, int) from public;
grant execute on function public.admin_list_requests(text, int, int) to anon, authenticated;

create or replace function public.admin_autopay_overview() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_autopay_overview') then return null; end if;
  return jsonb_build_object(
    'enabled', private.setting_bool('autopay_enabled', false),
    'active', private.autopay_on(),
    'devices', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'paired', d.paired_at is not null,
        'pair_expires_at', d.pair_expires_at, 'paired_at', d.paired_at, 'last_seen_at', d.last_seen_at,
        'last_info', d.last_info, 'sms_count', d.sms_count) order by d.created_at desc)
      from private.sms_devices d where d.revoked_at is null), '[]'::jsonb),
    'unmatched', (select count(*) from public.bank_sms where status = 'unmatched'),
    'untrusted', (select count(*) from public.bank_sms where status = 'unmatched' and not trusted),
    'review', (select count(*) from public.membership_requests where status = 'pending' and auto and submitted_at < now() - interval '24 hours'),
    'waiting', (select count(*) from public.membership_requests where status = 'pending' and auto),
    'auto_approved_7d', (select count(*) from public.membership_requests where status = 'approved' and auto_state = 'matched' and decided_at > now() - interval '7 days'),
    'senders', coalesce((select jsonb_agg(x) from (select distinct sender as x from public.bank_sms
                         where received_at > now() - interval '60 days' and sender <> '' order by 1 limit 30) s), '[]'::jsonb));
end $$;

create or replace function public.admin_sms_pair_code(p_name text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_code text; v_alpha text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; v_b bytea := extensions.gen_random_bytes(8); i int;
begin
  if private.admin_denied('admin_sms_pair_code') then return null; end if;
  v_code := '';
  for i in 0..7 loop v_code := v_code || substr(v_alpha, (get_byte(v_b, i) % 32) + 1, 1); end loop;
  insert into private.sms_devices (name, pair_code_hash, pair_expires_at)
  values (left(btrim(coalesce(p_name, '')), 60), private.sha(v_code), now() + interval '15 minutes');
  return jsonb_build_object('code', v_code, 'expires_at', now() + interval '15 minutes');
end $$;

create or replace function public.admin_sms_revoke(p_device uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_sms_revoke') then return; end if;
  update private.sms_devices set revoked_at = now(), token_hash = null, pair_code_hash = null where id = p_device;
end $$;

create or replace function public.admin_list_bank_sms(p_status text default null, p_limit int default 50, p_offset int default 0)
returns table (id bigint, received_at timestamptz, sms_at timestamptz, sender text, body text, kind text, amount numeric,
               reference text, from_phone text, from_name text, trusted boolean, status text, request_id uuid,
               member_name text, device_name text, total bigint)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_list_bank_sms') then return; end if;
  return query
    select s.id, s.received_at, s.sms_at, s.sender, s.body, s.kind, s.amount, s.reference, s.from_phone, s.from_name,
           s.trusted, s.status, s.request_id, (select p.first_name || ' ' || p.last_name from public.membership_requests r
             join public.profiles p on p.id = r.user_id where r.id = s.request_id), d.name, count(*) over ()
    from public.bank_sms s left join private.sms_devices d on d.id = s.device_id
    where p_status is null or p_status = '' or s.status = p_status
    order by s.received_at desc, s.id desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- admin links an SMS to a request and approves it
create or replace function public.admin_match_sms(p_request uuid, p_sms bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_r record; v_s record;
begin
  if private.admin_denied('admin_match_sms') then return null; end if;
  select * into v_r from public.membership_requests where id = p_request for update;
  select * into v_s from public.bank_sms where id = p_sms for update;
  if v_r.id is null or v_s.id is null then raise exception 'not_found'; end if;
  if v_r.status <> 'pending' then raise exception 'already_decided'; end if;
  if v_s.status = 'matched' then raise exception 'sms_used'; end if;
  perform private.approve_request(p_request, auth.uid(), 'Approved by admin with bank SMS #' || p_sms, p_sms);
  return private.membership_state(v_r.user_id);
end $$;

create or replace function public.admin_set_sms_status(p_sms bigint, p_status text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_set_sms_status') then return; end if;
  if p_status not in ('unmatched', 'ignored') then raise exception 'invalid_status'; end if;
  update public.bank_sms set status = p_status where id = p_sms and status <> 'matched';
  if p_status = 'unmatched' then perform private.try_match_sms(p_sms); end if;
end $$;

-- re-run matching for everything open (after turning autopay on, or after trusting a sender)
create or replace function public.admin_autopay_reconcile() returns int
language plpgsql volatile security definer set search_path = '' as $$
declare v_n int := 0; v_id uuid;
begin
  if private.admin_denied('admin_autopay_reconcile') then return null; end if;
  update public.bank_sms s set trusted = case
      when jsonb_typeof(a.v) = 'array' and jsonb_array_length(a.v) > 0
        then exists (select 1 from jsonb_array_elements_text(a.v) x where lower(btrim(x)) = lower(s.sender))
      else s.sender ~ '[A-Za-z]' or s.sender ~ '^[0-9]{3,6}$' end
    from (select data->'autopay_senders' as v from public.settings where id = 1) a
   where s.status = 'unmatched';
  for v_id in select id from public.membership_requests where status = 'pending' and auto order by submitted_at loop
    if private.try_match_request(v_id) then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end $$;

-- a request submitted while autopay was off can be switched to auto matching by the admin
revoke all on function public.admin_autopay_overview() from public;
revoke all on function public.admin_sms_pair_code(text) from public;
revoke all on function public.admin_sms_revoke(uuid) from public;
revoke all on function public.admin_list_bank_sms(text, int, int) from public;
revoke all on function public.admin_match_sms(uuid, bigint) from public;
revoke all on function public.admin_set_sms_status(bigint, text) from public;
revoke all on function public.admin_autopay_reconcile() from public;
grant execute on function public.admin_autopay_overview() to anon, authenticated;
grant execute on function public.admin_sms_pair_code(text) to anon, authenticated;
grant execute on function public.admin_sms_revoke(uuid) to anon, authenticated;
grant execute on function public.admin_list_bank_sms(text, int, int) to anon, authenticated;
grant execute on function public.admin_match_sms(uuid, bigint) to anon, authenticated;
grant execute on function public.admin_set_sms_status(bigint, text) to anon, authenticated;
grant execute on function public.admin_autopay_reconcile() to anon, authenticated;

create or replace function public.schema_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'version', 14,
    'm005', to_regclass('public.categories') is not null,
    'm006', to_regclass('public.complaints') is not null,
    'm007', to_regclass('public.areas') is not null,
    'm008', to_regclass('public.membership_requests') is not null,
    'm009', to_regclass('public.trials') is not null,
    'm010', to_regprocedure('public.home_feed(uuid, integer, integer, integer)') is not null,
    'm011', to_regclass('public.branches') is not null,
    'm012', to_regclass('public.discount_rules') is not null,
    'm013', to_regclass('public.explore_ads') is not null,
    'm014', to_regclass('public.bank_sms') is not null)
$$;
