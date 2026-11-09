-- =====================================================================
-- XGo Plus — 011 branches (a partner can be in several areas)
-- - branches: area, optional name, address, phone, Google Maps link (admin only)
-- - providers.area_ids = main area + every active branch's area (kept by triggers)
-- - area filters (home feed, search, offers) match ANY of the partner's areas
-- Idempotent. Run after 010.
-- =====================================================================

create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers(id) on delete cascade,
  area_id uuid references public.areas(id) on delete set null,
  name text not null default '' check (length(name) <= 80),
  address text not null default '' check (length(address) <= 300),
  phone text check (phone is null or phone ~ '^\+?[0-9]{5,15}$'),
  maps_url text check (maps_url is null or (length(maps_url) <= 500 and maps_url ~ '^https://(www\.google\.[a-z.]+/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl/maps)/')),
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists branches_provider on public.branches (provider_id, sort_order);
create index if not exists branches_area on public.branches (area_id) where is_active;
alter table public.branches enable row level security;
revoke all on public.branches from anon, authenticated;
grant select (id, provider_id, area_id, name, address, phone, maps_url, sort_order, is_active) on public.branches to anon, authenticated;
grant insert (provider_id, area_id, name, address, phone, maps_url, sort_order, is_active),
      update (area_id, name, address, phone, maps_url, sort_order, is_active), delete on public.branches to authenticated;

-- (policy helper runs with owner rights: the caller can't read providers.user_id)
create or replace function public.branch_visible(p_provider uuid, p_active boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select (p_active and exists (select 1 from public.providers p where p.id = p_provider and p.is_active))
      or exists (select 1 from public.providers p where p.id = p_provider and p.user_id = auth.uid())
      or public.is_admin()
$$;
revoke all on function public.branch_visible(uuid, boolean) from public;
grant execute on function public.branch_visible(uuid, boolean) to anon, authenticated;

drop policy if exists branches_read on public.branches;
create policy branches_read on public.branches for select to anon, authenticated
  using (public.branch_visible(provider_id, is_active));
drop policy if exists branches_admin_insert on public.branches;
create policy branches_admin_insert on public.branches for insert to authenticated with check ((select public.is_admin()));
drop policy if exists branches_admin_update on public.branches;
create policy branches_admin_update on public.branches for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists branches_admin_delete on public.branches;
create policy branches_admin_delete on public.branches for delete to authenticated using ((select public.is_admin()));

create or replace function private.branches_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.name := private.clean_name(new.name);
  new.address := btrim(regexp_replace(coalesce(new.address, ''), '[[:cntrl:]<>]', ' ', 'g'));
  new.phone := nullif(regexp_replace(coalesce(new.phone, ''), '[^0-9+]', '', 'g'), '');
  new.maps_url := nullif(btrim(coalesce(new.maps_url, '')), '');
  if new.area_id is null and new.address = '' then raise exception 'branch_needs_area_or_address'; end if;
  return new;
end $$;
drop trigger if exists branches_guard on public.branches;
create trigger branches_guard before insert or update on public.branches
  for each row execute function private.branches_guard();

-- ---------------------------------------------------------------------
-- providers.area_ids (main area + branch areas)
-- ---------------------------------------------------------------------
alter table public.providers add column if not exists area_ids uuid[] not null default '{}';
create index if not exists providers_area_ids on public.providers using gin (area_ids) where is_active;
grant select (area_ids) on public.providers to anon, authenticated;

create or replace function private.provider_area_ids(p_id uuid, p_main uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct a) filter (where a is not null), '{}')
  from (select p_main as a
        union all
        select b.area_id from public.branches b where b.provider_id = p_id and b.is_active) x
$$;

create or replace function private.providers_area_ids_trg() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.area_ids := private.provider_area_ids(new.id, new.area_id);
  return new;
end $$;
drop trigger if exists providers_area_ids on public.providers;
create trigger providers_area_ids before insert or update of area_id on public.providers
  for each row execute function private.providers_area_ids_trg();

create or replace function private.branches_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.providers p set area_ids = private.provider_area_ids(p.id, p.area_id)
   where p.id in (coalesce(new.provider_id, old.provider_id), coalesce(old.provider_id, new.provider_id));
  return null;
end $$;
drop trigger if exists branches_sync on public.branches;
create trigger branches_sync after insert or update or delete on public.branches
  for each row execute function private.branches_sync();

-- a deleted area disappears from every partner's list
create or replace function private.areas_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.providers p set area_ids = private.provider_area_ids(p.id, p.area_id) where old.id = any (p.area_ids);
  return null;
end $$;
drop trigger if exists areas_sync on public.areas;
create trigger areas_sync after delete on public.areas for each row execute function private.areas_sync();

update public.providers p set area_ids = private.provider_area_ids(p.id, p.area_id)
 where p.area_ids is distinct from private.provider_area_ids(p.id, p.area_id);

-- ---------------------------------------------------------------------
-- Area filters now use area_ids
-- ---------------------------------------------------------------------
drop function if exists public.search_providers(text, uuid, int, int, numeric, uuid);
create or replace function public.search_providers(
  p_q text, p_category uuid default null, p_limit int default 20, p_offset int default 0,
  p_min_discount numeric default null, p_area uuid default null
) returns table (id uuid, name text, image_path text, discount_percent numeric, category_id uuid, area_id uuid, area_name text, areas_count int)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_q text := private.norm(left(coalesce(p_q, ''), 60));
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 20);
begin
  if length(v_q) = 0 then return; end if;
  return query
    select p.id, p.name, p.image_path, p.discount_percent, p.category_id, p.area_id,
           coalesce(case when p_area is not null then (select a2.name from public.areas a2 where a2.id = p_area) end, a.name),
           cardinality(p.area_ids)
    from public.providers p
    left join public.categories c on c.id = p.category_id and c.is_active
    left join public.areas a on a.id = p.area_id
    where p.is_active
      and (p_category is null or p.category_id = p_category)
      and (p_area is null or p_area = any (p.area_ids))
      and (p_min_discount is null or p.discount_percent >= p_min_discount)
      and (
        p.search_name like '%' || v_q || '%'
        or extensions.word_similarity(v_q, p.search_name) >= 0.4
        or (length(v_q) >= 3 and c.search_name like v_q || '%')
      )
    order by
      (p.search_name like v_q || '%') desc,
      (p.search_name like '%' || v_q || '%') desc,
      extensions.word_similarity(v_q, p.search_name) desc,
      p.sort_order, p.name, p.id
    limit v_limit offset greatest(coalesce(p_offset, 0), 0);
end $$;
revoke all on function public.search_providers(text, uuid, int, int, numeric, uuid) from public;
grant execute on function public.search_providers(text, uuid, int, int, numeric, uuid) to anon, authenticated;

create or replace function public.home_feed(p_area uuid default null, p_top int default 10, p_rows int default 5, p_per_row int default 10)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_top int := least(greatest(coalesce(p_top, 10), 1), 20);
  v_rows int := least(greatest(coalesce(p_rows, 5), 0), 10);
  v_per int := least(greatest(coalesce(p_per_row, 10), 1), 20);
  v_area_name text := (select name from public.areas where id = p_area);
  v_res jsonb;
begin
  with base as (
    select p.id, p.name, p.image_path, p.discount_percent, p.category_id, p.sort_order,
           coalesce(v_area_name, a.name) as area_name, cardinality(p.area_ids) as areas_count,
           row_number() over (partition by coalesce(p.category_id, p.id)
                              order by p.discount_percent desc, p.sort_order, p.name, p.id) as rk
    from public.providers p
    left join public.areas a on a.id = p.area_id
    where p.is_active and (p_area is null or p_area = any (p.area_ids))
  ),
  top as (
    select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'image_path', image_path, 'discount_percent', discount_percent,
                                        'area_name', area_name, 'areas_count', areas_count) order by ord) as items
    from (select *, row_number() over (order by rk, discount_percent desc, sort_order, name, id) as ord from base) x
    where ord <= v_top
  ),
  cats as (
    select c.id, c.name, c.icon, c.sort_order
    from public.categories c
    where c.is_active and exists (select 1 from base b where b.category_id = c.id)
    order by c.sort_order, c.name
    limit v_rows
  ),
  rows as (
    select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'icon', c.icon,
             'items', (select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'image_path', b.image_path,
                                                           'discount_percent', b.discount_percent, 'area_name', b.area_name,
                                                           'areas_count', b.areas_count) order by b.rk)
                       from base b where b.category_id = c.id and b.rk <= v_per))
           order by c.sort_order, c.name) as items
    from cats c
  )
  select jsonb_build_object('top', coalesce((select items from top), '[]'::jsonb),
                            'rows', coalesce((select items from rows), '[]'::jsonb))
    into v_res;
  return v_res;
end $$;
revoke all on function public.home_feed(uuid, int, int, int) from public;
grant execute on function public.home_feed(uuid, int, int, int) to anon, authenticated;

create or replace function public.admin_area_counts() returns table (area_id uuid, providers bigint)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_area_counts') then return; end if;
  return query select a, count(*) from public.providers p, unnest(p.area_ids) a group by a;
end $$;
revoke all on function public.admin_area_counts() from public;
grant execute on function public.admin_area_counts() to anon, authenticated;

create or replace function public.schema_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'version', 11,
    'm005', to_regclass('public.categories') is not null,
    'm006', to_regclass('public.complaints') is not null,
    'm007', to_regclass('public.areas') is not null,
    'm008', to_regclass('public.membership_requests') is not null,
    'm009', to_regclass('public.trials') is not null,
    'm010', to_regprocedure('public.home_feed(uuid, integer, integer, integer)') is not null,
    'm011', to_regclass('public.branches') is not null)
$$;
