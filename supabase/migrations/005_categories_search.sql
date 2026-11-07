-- =====================================================================
-- XGo Plus — 005 categories + typo-tolerant search
-- - categories (admin-managed), providers.category_id
-- - normalized search text (lowercase, Arabic letter variants unified,
--   diacritics/punctuation removed) with trigram index
-- - search_providers(): substring OR fuzzy (word similarity) matching,
--   best matches first, paginated
-- Idempotent.
-- =====================================================================

create extension if not exists pg_trgm with schema extensions;

-- Text normalizer used for search (immutable -> usable in generated columns)
create or replace function private.norm(p text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select btrim(regexp_replace(
    translate(
      regexp_replace(lower(coalesce(p, '')), '[ً-ْـ]', '', 'g'),   -- tashkeel + tatweel
      'أإآٱىةؤئéèêëàâäáíìîïóòôöúùûüçñ',
      'اااايهويeeeeaaaaiiiioooouuuucn'),
    '[^[:alnum:]؀-ۿ]+', ' ', 'g'))
$$;

-- ---------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 60),
  icon text not null default '' check (length(icon) <= 8),
  image_path text check (image_path is null or (length(image_path) <= 300 and image_path like 'categories/%')),
  sort_order int not null default 0,
  is_active boolean not null default true,
  search_name text generated always as (private.norm(name)) stored,
  created_at timestamptz not null default now()
);
create index if not exists categories_active_sort on public.categories (is_active, sort_order, name);
alter table public.categories enable row level security;
revoke all on public.categories from anon, authenticated;
grant select (id, name, icon, image_path, sort_order, is_active, created_at) on public.categories to anon, authenticated;
grant insert (name, icon, image_path, sort_order, is_active),
      update (name, icon, image_path, sort_order, is_active),
      delete on public.categories to authenticated;

drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories for select to anon, authenticated
  using (is_active or (select public.is_admin()));
drop policy if exists categories_admin_insert on public.categories;
create policy categories_admin_insert on public.categories for insert to authenticated with check ((select public.is_admin()));
drop policy if exists categories_admin_update on public.categories;
create policy categories_admin_update on public.categories for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists categories_admin_delete on public.categories;
create policy categories_admin_delete on public.categories for delete to authenticated using ((select public.is_admin()));

create or replace function private.categories_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.name := private.clean_name(new.name);
  new.icon := btrim(regexp_replace(coalesce(new.icon, ''), '[[:cntrl:]<>]', '', 'g'));
  if length(new.name) = 0 then raise exception 'invalid_name'; end if;
  if new.image_path = '' then new.image_path := null; end if;
  return new;
end $$;
drop trigger if exists categories_guard on public.categories;
create trigger categories_guard before insert or update on public.categories
  for each row execute function private.categories_guard();

-- Starter categories (only when the table is empty)
insert into public.categories (name, icon, sort_order)
select * from (values ('Cafés', '☕', 1), ('Restaurants', '🍽️', 2), ('Gyms', '🏋️', 3),
                      ('Clinics', '🩺', 4), ('Beauty', '💅', 5), ('Shopping', '🛍️', 6)) v(name, icon, sort_order)
where not exists (select 1 from public.categories);

-- ---------------------------------------------------------------------
-- Providers: category + search column
-- ---------------------------------------------------------------------
alter table public.providers add column if not exists category_id uuid references public.categories(id) on delete set null;
alter table public.providers add column if not exists search_name text generated always as (private.norm(name)) stored;
create index if not exists providers_category on public.providers (category_id, sort_order, name, id) where is_active;
create index if not exists providers_search_trgm on public.providers using gin (search_name extensions.gin_trgm_ops);
drop index if exists public.providers_name_trgm;
grant select (category_id) on public.providers to anon, authenticated;

-- ---------------------------------------------------------------------
-- Search. Matches when the normalized query is contained in the name,
-- when it is "close enough" to a word sequence in the name (typos),
-- or when it matches the category name. Ranked: prefix > contains > similarity.
-- ---------------------------------------------------------------------
-- 006 adds a 5th parameter; drop it here so a full re-run never leaves two versions
drop function if exists public.search_providers(text, uuid, int, int, numeric);
create or replace function public.search_providers(
  p_q text, p_category uuid default null, p_limit int default 20, p_offset int default 0
) returns table (id uuid, name text, image_path text, discount_percent numeric, category_id uuid)
language plpgsql stable security definer
set search_path = ''
set pg_trgm.word_similarity_threshold = 0.4
as $$
declare
  v_q text := private.norm(left(coalesce(p_q, ''), 60));
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 20);
begin
  if length(v_q) = 0 then return; end if;
  return query
    select p.id, p.name, p.image_path, p.discount_percent, p.category_id
    from public.providers p
    left join public.categories c on c.id = p.category_id and c.is_active
    where p.is_active
      and (p_category is null or p.category_id = p_category)
      and (
        p.search_name like '%' || v_q || '%'
        or v_q operator(extensions.<%) p.search_name
        or (length(v_q) >= 3 and c.search_name like v_q || '%')
      )
    order by
      (p.search_name like v_q || '%') desc,
      (p.search_name like '%' || v_q || '%') desc,
      extensions.word_similarity(v_q, p.search_name) desc,
      p.sort_order, p.name, p.id
    limit v_limit offset greatest(coalesce(p_offset, 0), 0);
end $$;
revoke all on function public.search_providers(text, uuid, int, int) from public;
grant execute on function public.search_providers(text, uuid, int, int) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Admin RPCs now handle category
-- ---------------------------------------------------------------------
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
    sort_order = case when p_patch ? 'sort_order' then (p_patch->>'sort_order')::int else sort_order end,
    category_id = case when p_patch ? 'category_id' then nullif(p_patch->>'category_id', '')::uuid else category_id end
  where id = p_id;
  if not found then raise exception 'not_found'; end if;
end $$;

drop function if exists public.admin_list_providers(text, int, int);
create or replace function public.admin_list_providers(
  p_search text default '', p_limit int default 50, p_offset int default 0
) returns table (
  id uuid, username text, name text, image_path text, discount_percent numeric, notes text,
  is_active boolean, sort_order int, created_at timestamptz, category_id uuid, category_name text, total bigint
)
language plpgsql stable security definer set search_path = '' as $$
declare v_q text := btrim(coalesce(p_search, ''));
begin
  perform private.assert_admin();
  return query
    select p.id, p.username, p.name, p.image_path, p.discount_percent, p.notes,
           p.is_active, p.sort_order, p.created_at, p.category_id, c.name, count(*) over ()
    from public.providers p
    left join public.categories c on c.id = p.category_id
    where v_q = '' or p.name ilike '%' || v_q || '%' or p.username ilike '%' || v_q || '%'
    order by p.sort_order, p.name, p.id
    limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;
revoke all on function public.admin_list_providers(text, int, int) from public, anon;
grant execute on function public.admin_list_providers(text, int, int) to authenticated;
revoke all on function public.admin_update_provider(uuid, jsonb) from public, anon;
grant execute on function public.admin_update_provider(uuid, jsonb) to authenticated;

-- Category counts for the admin tab
create or replace function public.admin_category_counts() returns table (category_id uuid, providers bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_admin();
  return query select p.category_id, count(*) from public.providers p where p.category_id is not null group by p.category_id;
end $$;
revoke all on function public.admin_category_counts() from public, anon;
grant execute on function public.admin_category_counts() to authenticated;
