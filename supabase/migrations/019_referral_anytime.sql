-- 019: a friend's referral code can be added any time before their first paid
-- membership (no 7-day limit). The commission is paid whenever that friend
-- buys the yearly membership — next week or months later.
-- Safe to run more than once.

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
  if exists (select 1 from public.membership_requests where user_id = v_uid and status = 'approved') then
    raise exception 'referrer_too_late';
  end if;
  select id, first_name, referred_by into v_ref from public.profiles where referral_code = private.norm_code(p_code);
  if v_ref.id is null then raise exception 'invalid_referral_code'; end if;
  if v_ref.id = v_uid or v_ref.referred_by = v_uid then raise exception 'invalid_referral_code'; end if;
  update public.profiles set referred_by = v_ref.id, referred_at = now() where id = v_uid;
  return jsonb_build_object('name', v_ref.first_name);
end $$;

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
    'can_set_referrer', v_p.referred_by is null
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

comment on function public.set_referrer(text) is 'xgo:m019';

create or replace function public.schema_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'version', 19,
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
    'm018', to_regclass('public.wallet_entries') is not null,
    'm019', coalesce(obj_description('public.set_referrer(text)'::regprocedure, 'pg_proc'), '') = 'xgo:m019')
$$;
