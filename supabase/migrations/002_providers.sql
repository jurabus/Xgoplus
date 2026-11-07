-- =====================================================================
-- XGo Plus — 002 providers module
-- Providers (businesses offering discounts). Accounts are created ONLY by
-- an admin. Providers log in with username + password
-- (internal email <username>@p.xgoplus.online).
-- Idempotent.
-- =====================================================================

create extension if not exists pg_trgm with schema extensions;

create table if not exists public.providers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  username text not null unique check (username ~ '^[a-z0-9_]{3,30}$'),
  name text not null check (length(name) between 1 and 80),
  image_path text check (image_path is null or length(image_path) <= 300),
  discount_percent numeric(5,2) not null check (discount_percent > 0 and discount_percent <= 100),
  notes text not null default '' check (length(notes) <= 1000),
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists providers_list on public.providers (sort_order, name, id) where is_active;
create index if not exists providers_name_trgm on public.providers using gin (name extensions.gin_trgm_ops);
alter table public.providers enable row level security;

revoke all on public.providers from anon, authenticated;
grant select (id, name, image_path, discount_percent, notes, sort_order, is_active, created_at, updated_at)
  on public.providers to anon, authenticated;
-- Providers may change ONLY these columns of their own row:
grant update (name, image_path, discount_percent, notes) on public.providers to authenticated;

drop policy if exists providers_read on public.providers;
create policy providers_read on public.providers for select to anon, authenticated
  using (is_active or user_id = (select auth.uid()) or (select public.is_admin()));
drop policy if exists providers_self_update on public.providers;
create policy providers_self_update on public.providers for update to authenticated
  using (user_id = (select auth.uid()) and is_active)
  with check (user_id = (select auth.uid()) and is_active);

create or replace function private.providers_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.name := private.clean_name(new.name);
  new.notes := btrim(regexp_replace(coalesce(new.notes, ''), '[\x01-\x09\x0b-\x1f\x7f<>]', '', 'g'));
  if length(new.name) = 0 then raise exception 'invalid_name'; end if;
  if new.image_path is not null and new.image_path <> ''
     and new.image_path !~ ('^providers/' || new.id::text || '/[A-Za-z0-9._-]{1,100}$') then
    raise exception 'invalid_image_path';
  end if;
  if new.image_path = '' then new.image_path := null; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists providers_guard on public.providers;
create trigger providers_guard before insert or update on public.providers
  for each row execute function private.providers_guard();

create or replace function public.my_provider_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.id from public.providers p where p.user_id = auth.uid() and p.is_active
$$;
revoke all on function public.my_provider_id() from public;
grant execute on function public.my_provider_id() to authenticated;

-- ---------------------------------------------------------------------
-- Admin RPCs
-- ---------------------------------------------------------------------
create or replace function private.assert_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
end $$;

create or replace function private.check_password(p text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or length(p) < 8 or length(p) > 72 then raise exception 'weak_password'; end if;
end $$;

create or replace function public.admin_create_provider(
  p_username text, p_password text, p_name text, p_discount numeric, p_notes text default ''
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_email text;
  v_uid uuid := gen_random_uuid();
  v_pid uuid := gen_random_uuid();
begin
  perform private.assert_admin();
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
    extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '', '', '', '',
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'xg_kind', 'provider'),
    '{}'::jsonb, now(), now()
  );
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
  perform private.assert_admin();
  update public.providers set
    name = case when p_patch ? 'name' then p_patch->>'name' else name end,
    discount_percent = case when p_patch ? 'discount_percent' then (p_patch->>'discount_percent')::numeric else discount_percent end,
    notes = case when p_patch ? 'notes' then coalesce(p_patch->>'notes', '') else notes end,
    image_path = case when p_patch ? 'image_path' then p_patch->>'image_path' else image_path end,
    is_active = case when p_patch ? 'is_active' then (p_patch->>'is_active')::boolean else is_active end,
    sort_order = case when p_patch ? 'sort_order' then (p_patch->>'sort_order')::int else sort_order end
  where id = p_id;
  if not found then raise exception 'not_found'; end if;
end $$;

create or replace function public.admin_set_provider_password(p_id uuid, p_password text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  perform private.assert_admin();
  perform private.check_password(p_password);
  select user_id into v_uid from public.providers where id = p_id;
  if v_uid is null then raise exception 'not_found'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
                        updated_at = now()
  where id = v_uid;
end $$;

create or replace function public.admin_delete_provider(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  perform private.assert_admin();
  select user_id into v_uid from public.providers where id = p_id;
  delete from public.providers where id = p_id;
  if not found then raise exception 'not_found'; end if;
  if v_uid is not null then delete from auth.users where id = v_uid; end if;
end $$;

create or replace function public.admin_list_providers(
  p_search text default '', p_limit int default 50, p_offset int default 0
) returns table (
  id uuid, username text, name text, image_path text, discount_percent numeric, notes text,
  is_active boolean, sort_order int, created_at timestamptz, total bigint
)
language plpgsql stable security definer set search_path = '' as $$
declare v_q text := btrim(coalesce(p_search, ''));
begin
  perform private.assert_admin();
  return query
    select p.id, p.username, p.name, p.image_path, p.discount_percent, p.notes,
           p.is_active, p.sort_order, p.created_at, count(*) over ()
    from public.providers p
    where v_q = '' or p.name ilike '%' || v_q || '%' or p.username ilike '%' || v_q || '%'
    order by p.sort_order, p.name, p.id
    limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

revoke all on function public.admin_create_provider(text, text, text, numeric, text) from public, anon;
revoke all on function public.admin_update_provider(uuid, jsonb) from public, anon;
revoke all on function public.admin_set_provider_password(uuid, text) from public, anon;
revoke all on function public.admin_delete_provider(uuid) from public, anon;
revoke all on function public.admin_list_providers(text, int, int) from public, anon;
grant execute on function public.admin_create_provider(text, text, text, numeric, text) to authenticated;
grant execute on function public.admin_update_provider(uuid, jsonb) to authenticated;
grant execute on function public.admin_set_provider_password(uuid, text) to authenticated;
grant execute on function public.admin_delete_provider(uuid) to authenticated;
grant execute on function public.admin_list_providers(text, int, int) to authenticated;

-- ---------------------------------------------------------------------
-- Context RPC now knows about providers.
-- ---------------------------------------------------------------------
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
    'provider', v_provider
  );
end $$;
revoke all on function public.get_my_context() from public;
grant execute on function public.get_my_context() to anon, authenticated;
