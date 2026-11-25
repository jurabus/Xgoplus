-- =====================================================================
-- XGo Plus — 017 SMS privacy (Egypt PDPL, Law 151/2020: data minimisation)
-- * The parser now treats as "not a payment" anything that looks like a
--   code / OTP / password / PIN, any debit / purchase / bill / outgoing
--   transfer, and salary or payroll alerts — even if a phone with an old
--   app version sends them.
-- * SMS that are not payments are stored masked only (digits and words
--   after "من" / "باسم" removed), never readable; existing rows are masked.
-- * Bank SMS older than 180 days lose their text (amounts, references and
--   matches stay for accounting).
-- Idempotent. Run after 016.
-- =====================================================================

create or replace function private.mask_sms(p text) returns text
language sql immutable set search_path = '' as $$
  select left(regexp_replace(regexp_replace(private.ascii_digits(coalesce(p, '')), '[0-9]', '•', 'g'),
                             '(من|باسم|from|to|إلى|الى)\s+\S+(\s+\S+){0,4}', '\1 …', 'gi'), 300)
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
  v_out := b ~* '(خصم|سحب|شراء|مشتريات|دفع|سداد|فاتورة|قسط|تم تحويل مبلغ|debit|withdraw|purchase|spent|paid to|payment of|sent to|you sent|transfer(red)? to|bill|instal?lment)'
        -- codes / secrets and salary alerts are never payments (Law 151: don't keep them)
        or b ~* '(\motp\M|one[- ]?time|\mcode\M|\mpin\M|passcode|password|verification|verify|authenticat|3-?d ?secure|كود|رمز|كلمة|كلمه|السر|المرور|تحقق|تفعيل|لا ?تشارك|صالح(ة)? لمدة)'
        or b ~* '(salary|payroll|راتب|مرتب)';
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
  -- not a payment: keep only a masked trace (no digits, no names) so format changes can be spotted
  values (v_dev, v_sender, case when v_p.kind = 'other' then private.mask_sms(v_body) else v_body end,
          private.sha(v_sender || '|' || v_body || '|' || coalesce(p_sms_at::text, '')),
          least(coalesce(p_sms_at, now()), now()), v_p.kind, v_p.amount, v_p.reference, v_p.from_phone, v_p.from_name, v_trusted,
          case when v_p.kind = 'other' then 'ignored' else 'unmatched' end)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then return jsonb_build_object('stored', false, 'duplicate', true); end if;
  if v_p.kind <> 'other' then v_matched := private.try_match_sms(v_id); end if;
  return jsonb_build_object('stored', true, 'kind', v_p.kind, 'matched', v_matched);
end $$;

-- re-check everything already stored with the stricter rules; mask what isn't a payment
update public.bank_sms s set kind = 'other', status = 'ignored', amount = null, reference = null, from_phone = null, from_name = null
  from (select id, (private.parse_bank_sms(body)).kind as k from public.bank_sms where status <> 'matched') x
 where x.id = s.id and x.k = 'other' and s.kind <> 'other';
update public.bank_sms set body = private.mask_sms(body), from_name = null
 where kind = 'other' and body ~ '[0-9٠-٩]';

-- retention: keep the parsed facts, drop the raw text after 180 days
create or replace function private.sms_retention() returns void
language sql security definer set search_path = '' as $$
  update public.bank_sms set body = '[removed after 180 days]', from_name = null
   where received_at < now() - interval '180 days' and body <> '[removed after 180 days]'
$$;
select private.sms_retention();

-- run retention with the hourly offers refresh
create or replace function private.refresh_offers() returns void
language plpgsql security definer set search_path = '' as $$
declare v_last timestamptz;
begin
  select last_run into v_last from private.job_runs where name = 'offers';
  if v_last is not null and v_last > now() - interval '1 hour' then return; end if;
  insert into private.job_runs (name, last_run) values ('offers', now())
  on conflict (name) do update set last_run = now() where private.job_runs.last_run <= now() - interval '1 hour';
  if not found then return; end if;
  perform private.sync_provider_offers(array(select distinct provider_id from public.discount_rules
                                               where starts_on is not null or ends_on is not null));
  perform private.sms_retention();
end $$;

create or replace function public.schema_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'version', 17,
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
    'm017', to_regprocedure('private.mask_sms(text)') is not null)
$$;
