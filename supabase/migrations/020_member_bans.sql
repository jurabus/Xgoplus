-- 020: admin can delete a member account, or delete it AND ban the phone number
-- for good (the number can never register again until an admin lifts the ban).
-- Partner and admin accounts can't be removed here.
-- Safe to run more than once.

create table if not exists public.banned_phones (
  phone      text primary key check (phone ~ '^20[0-9]{10}$'),
  name       text not null default '',
  reason     text not null default '',
  banned_at  timestamptz not null default now(),
  banned_by  uuid
);
alter table public.banned_phones enable row level security;
revoke all on public.banned_phones from public, anon, authenticated;

-- '01012345678' / '+20 101 234 5678' / '201012345678' -> '201012345678' (null if not an Egyptian mobile)
create or replace function private.norm_phone(p text) returns text
language sql immutable set search_path = '' as $$
  select case when d ~ '^201[0-9]{9}$' then d end
  from (select case
                 when x ~ '^00' then substr(x, 3)
                 when x ~ '^0'  then '2' || x
                 else x end as d
        from (select regexp_replace(translate(coalesce(p, ''), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '[^0-9]', '', 'g') as x) a) b
$$;

-- profiles guard: a member whose referrer was deleted gets referred_by cleared
-- (before, the guard put the old value back and left a dangling link).
create or replace function private.profiles_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.first_name := private.clean_name(new.first_name);
  new.last_name := private.clean_name(new.last_name);
  new.updated_at := now();
  if new.referral_code is null then new.referral_code := private.new_referral_code(); end if;
  if tg_op = 'UPDATE' then
    new.referral_code := old.referral_code;
    if old.referred_by is not null
       and (new.referred_by is not null or exists (select 1 from public.profiles r where r.id = old.referred_by)) then
      new.referred_by := old.referred_by; new.referred_at := old.referred_at;
    end if;
  end if;
  if new.referred_by = new.id then new.referred_by := null; new.referred_at := null; end if;
  return new;
end $$;

-- Block sign-ups from banned numbers (runs before the account is created).
create or replace function private.block_banned_signup() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_phone text;
begin
  v_phone := coalesce(substring(new.email from '^u([0-9]{8,15})@'), private.norm_phone(new.raw_user_meta_data->>'phone'));
  if v_phone is not null and exists (select 1 from public.banned_phones b where b.phone = v_phone) then
    raise exception 'phone_banned';
  end if;
  return new;
end $$;

drop trigger if exists xg_block_banned_signup on auth.users;
create trigger xg_block_banned_signup before insert on auth.users
  for each row execute function private.block_banned_signup();

-- What the admin sees before deleting (money and payments that go with the account).
create or replace function public.admin_member_delete_info(p_user uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_p public.profiles;
begin
  if private.admin_denied('admin_member_delete_info') then return null; end if;
  select * into v_p from public.profiles where id = p_user;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object(
    'phone', v_p.phone,
    'protected', exists (select 1 from public.admins a where a.user_id = p_user)
                 or exists (select 1 from public.providers pr where pr.user_id = p_user),
    'wallet', coalesce((select sum(amount) from public.wallet_entries where user_id = p_user), 0),
    'pending_withdrawals', (select count(*) from public.withdrawal_requests where user_id = p_user and status = 'pending'),
    'payments', (select count(*) from public.membership_requests where user_id = p_user),
    'active_until', (select max(expires_at) from public.memberships where user_id = p_user and expires_at > now()),
    'banned', exists (select 1 from public.banned_phones where phone = v_p.phone));
end $$;

-- Delete a member account (and optionally ban the phone).
-- Their membership, payment requests, wallet and complaints go with it; scans stay
-- in partner stats without the name; friends they invited keep their accounts.
create or replace function public.admin_delete_member(p_user uuid, p_ban boolean default false, p_reason text default '') returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_p public.profiles;
begin
  if private.admin_denied('admin_delete_member') then return null; end if;
  select * into v_p from public.profiles where id = p_user for update;
  if not found then raise exception 'not_found'; end if;
  if p_user = auth.uid()
     or exists (select 1 from public.admins a where a.user_id = p_user)
     or exists (select 1 from public.providers pr where pr.user_id = p_user) then
    raise exception 'cannot_delete_staff';
  end if;
  if coalesce(p_ban, false) then
    insert into public.banned_phones (phone, name, reason, banned_by)
    values (v_p.phone, left(v_p.first_name || ' ' || v_p.last_name, 120), left(btrim(coalesce(p_reason, '')), 300), auth.uid())
    on conflict (phone) do update set reason = excluded.reason, name = excluded.name, banned_at = now(), banned_by = excluded.banned_by;
  end if;
  delete from auth.users where id = p_user;      -- cascades to profile, sessions, memberships, wallet…
  return jsonb_build_object('deleted', true, 'banned', coalesce(p_ban, false), 'phone', v_p.phone);
end $$;

-- Ban a number directly (e.g. before it registers). If a member account uses it, that account is deleted.
create or replace function public.admin_ban_phone(p_phone text, p_reason text default '') returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_phone text := private.norm_phone(p_phone); v_uid uuid;
begin
  if private.admin_denied('admin_ban_phone') then return null; end if;
  if v_phone is null then raise exception 'invalid_phone'; end if;
  select id into v_uid from public.profiles where phone = v_phone;
  if v_uid is not null then
    return public.admin_delete_member(v_uid, true, p_reason);
  end if;
  insert into public.banned_phones (phone, reason, banned_by)
  values (v_phone, left(btrim(coalesce(p_reason, '')), 300), auth.uid())
  on conflict (phone) do update set reason = excluded.reason, banned_at = now(), banned_by = excluded.banned_by;
  return jsonb_build_object('deleted', false, 'banned', true, 'phone', v_phone);
end $$;

create or replace function public.admin_unban_phone(p_phone text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_unban_phone') then return null; end if;
  delete from public.banned_phones where phone = private.norm_phone(p_phone);
  return found;
end $$;

create or replace function public.admin_list_banned(p_search text default '', p_limit int default 50, p_offset int default 0)
returns table (phone text, name text, reason text, banned_at timestamptz, total bigint)
language plpgsql volatile security definer set search_path = '' as $$
declare v_q text := btrim(coalesce(p_search, '')); v_d text;
begin
  if private.admin_denied('admin_list_banned') then return; end if;
  v_d := regexp_replace(v_q, '[^0-9]', '', 'g');
  if v_d ~ '^0' then v_d := '2' || v_d; end if;
  return query
    select b.phone, b.name, b.reason, b.banned_at, count(*) over ()
    from public.banned_phones b
    where v_q = '' or (length(v_d) >= 3 and b.phone like '%' || v_d || '%') or b.name ilike '%' || v_q || '%'
    order by b.banned_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

revoke all on function public.admin_member_delete_info(uuid) from public, anon;
revoke all on function public.admin_delete_member(uuid, boolean, text) from public, anon;
revoke all on function public.admin_ban_phone(text, text) from public, anon;
revoke all on function public.admin_unban_phone(text) from public, anon;
revoke all on function public.admin_list_banned(text, int, int) from public, anon;
grant execute on function public.admin_member_delete_info(uuid) to authenticated;
grant execute on function public.admin_delete_member(uuid, boolean, text) to authenticated;
grant execute on function public.admin_ban_phone(text, text) to authenticated;
grant execute on function public.admin_unban_phone(text) to authenticated;
grant execute on function public.admin_list_banned(text, int, int) to authenticated;

create or replace function public.schema_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'version', 20,
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
    'm019', coalesce(obj_description('public.set_referrer(text)'::regprocedure, 'pg_proc'), '') = 'xgo:m019',
    'm020', to_regclass('public.banned_phones') is not null)
$$;
