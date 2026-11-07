-- =====================================================================
-- XGo Plus — 001 base schema (core). Run ONCE in the Supabase SQL Editor,
-- then run migrations/002..., 003..., 004... in order.
-- Safe to re-run: everything is idempotent.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- Private schema: never exposed through the API (only "public" is).
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Admins
-- ---------------------------------------------------------------------
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid())
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- ---------------------------------------------------------------------
-- Rate limits (private)
-- ---------------------------------------------------------------------
create table if not exists private.rate_limits (
  bucket text not null,
  subject text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (bucket, subject, window_start)
);

-- Returns true if the call is allowed; false when the limit is exceeded.
create or replace function private.hit_rate_limit(
  p_bucket text, p_subject text, p_max int, p_window_seconds int
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits int;
begin
  insert into private.rate_limits as r (bucket, subject, window_start, hits)
  values (p_bucket, p_subject, v_window, 1)
  on conflict (bucket, subject, window_start) do update set hits = r.hits + 1
  returning hits into v_hits;
  if random() < 0.01 then
    delete from private.rate_limits where window_start < now() - interval '1 day';
  end if;
  return v_hits <= p_max;
end $$;
revoke all on function private.hit_rate_limit(text, text, int, int) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Secrets (private) — used to sign membership QR codes
-- ---------------------------------------------------------------------
create table if not exists private.app_secrets (
  name text primary key,
  value bytea not null
);
insert into private.app_secrets (name, value)
values ('qr_hmac', extensions.gen_random_bytes(32))
on conflict (name) do nothing;

-- ---------------------------------------------------------------------
-- Settings: one JSON row holding all customer-facing texts + switches.
-- Defaults live in code; this row only stores overrides.
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 200000),
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;
alter table public.settings enable row level security;
revoke all on public.settings from anon, authenticated;
grant select (id, data, updated_at) on public.settings to anon, authenticated;
grant update (data, updated_at) on public.settings to authenticated;

drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select to anon, authenticated using (true);
drop policy if exists settings_admin_update on public.settings;
create policy settings_admin_update on public.settings for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- ---------------------------------------------------------------------
-- Banners (home page carousel)
-- ---------------------------------------------------------------------
create table if not exists public.banners (
  id uuid primary key default gen_random_uuid(),
  image_path text check (image_path is null or (length(image_path) <= 300 and image_path like 'banners/%')),
  title text not null default '' check (length(title) <= 120),
  subtitle text not null default '' check (length(subtitle) <= 240),
  link_url text check (link_url is null or (length(link_url) <= 500 and link_url ~ '^(https://|/[^/])')),
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists banners_active_sort on public.banners (is_active, sort_order);
alter table public.banners enable row level security;
revoke all on public.banners from anon, authenticated;
grant select (id, image_path, title, subtitle, link_url, sort_order, is_active, created_at) on public.banners to anon, authenticated;
grant insert (image_path, title, subtitle, link_url, sort_order, is_active),
      update (image_path, title, subtitle, link_url, sort_order, is_active),
      delete on public.banners to authenticated;

drop policy if exists banners_read on public.banners;
create policy banners_read on public.banners for select to anon, authenticated
  using (is_active or (select public.is_admin()));
drop policy if exists banners_admin_insert on public.banners;
create policy banners_admin_insert on public.banners for insert to authenticated with check ((select public.is_admin()));
drop policy if exists banners_admin_update on public.banners;
create policy banners_admin_update on public.banners for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists banners_admin_delete on public.banners;
create policy banners_admin_delete on public.banners for delete to authenticated using ((select public.is_admin()));

-- ---------------------------------------------------------------------
-- Customer profiles. Created ONLY by the auth.users trigger below.
-- Phone login: phone 01xxxxxxxxx -> canonical 201xxxxxxxxx ->
-- internal email u201xxxxxxxxx@xgoplus.online
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  phone text not null unique check (phone ~ '^[0-9]{8,15}$'),
  first_name text not null check (length(first_name) between 1 and 40),
  last_name text not null check (length(last_name) between 1 and 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists profiles_created on public.profiles (created_at desc);
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select (id, phone, first_name, last_name, created_at) on public.profiles to authenticated;
grant update (first_name, last_name) on public.profiles to authenticated;

drop policy if exists profiles_own_read on public.profiles;
create policy profiles_own_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
drop policy if exists profiles_own_update on public.profiles;
create policy profiles_own_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create or replace function private.clean_name(p text) returns text
language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(coalesce(p, ''), '[[:cntrl:]<>]', '', 'g'))
$$;

create or replace function private.profiles_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.first_name := private.clean_name(new.first_name);
  new.last_name := private.clean_name(new.last_name);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before insert or update on public.profiles
  for each row execute function private.profiles_guard();

-- Trigger on auth.users: customer sign-ups (u<digits>@xgoplus.online) get a
-- profile from validated metadata. Anything else (admins created in the
-- dashboard, providers created by admin RPC) gets no profile here.
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_digits text;
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_first text;
  v_last text;
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
  insert into public.profiles (id, phone, first_name, last_name)
  values (new.id, v_digits, v_first, v_last);
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- Login emails are derived from phone/username, so they must never change
-- (blocks auth.updateUser({ email }) squatting another phone/username).
create or replace function private.block_email_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email is distinct from old.email
     and (coalesce(old.email, '') ~* '@(p\.)?xgoplus\.online$' or coalesce(new.email, '') ~* '@(p\.)?xgoplus\.online$') then
    raise exception 'email_change_not_allowed';
  end if;
  return new;
end $$;
drop trigger if exists block_email_change on auth.users;
create trigger block_email_change before update of email on auth.users
  for each row execute function private.block_email_change();

-- ---------------------------------------------------------------------
-- Storage bucket for images: public read; writes by admin anywhere,
-- providers only inside providers/<their provider id>/
-- (helper public.my_provider_id() is defined in 002_providers.sql;
--  a placeholder is created here so this file runs on its own)
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'my_provider_id') then
    execute 'create function public.my_provider_id() returns uuid language sql stable security definer set search_path = '''' as $f$ select null::uuid $f$';
  end if;
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 2097152,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

create or replace function public.can_write_media(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin()
      or (
        (storage.foldername(p_name))[1] = 'providers'
        and public.my_provider_id() is not null
        and (storage.foldername(p_name))[2] = public.my_provider_id()::text
        and array_length(storage.foldername(p_name), 1) = 2
      )
$$;
revoke all on function public.can_write_media(text) from public;
grant execute on function public.can_write_media(text) to authenticated;

drop policy if exists media_write_select on storage.objects;
create policy media_write_select on storage.objects for select to authenticated
  using (bucket_id = 'media' and public.can_write_media(name));
drop policy if exists media_insert on storage.objects;
create policy media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.can_write_media(name));
drop policy if exists media_update on storage.objects;
create policy media_update on storage.objects for update to authenticated
  using (bucket_id = 'media' and public.can_write_media(name))
  with check (bucket_id = 'media' and public.can_write_media(name));
drop policy if exists media_delete on storage.objects;
create policy media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and public.can_write_media(name));

-- ---------------------------------------------------------------------
-- Context RPC: one call tells the app who the user is.
-- (extended by later migrations via create or replace)
-- ---------------------------------------------------------------------
create or replace function public.get_my_context() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_profile jsonb;
begin
  if v_uid is null then return jsonb_build_object('role', 'guest'); end if;
  select to_jsonb(p) - 'updated_at' into v_profile from public.profiles p where p.id = v_uid;
  return jsonb_build_object(
    'role', case when public.is_admin() then 'admin' when v_profile is not null then 'customer' else 'none' end,
    'is_admin', public.is_admin(),
    'profile', v_profile
  );
end $$;
revoke all on function public.get_my_context() from public;
grant execute on function public.get_my_context() to anon, authenticated;
