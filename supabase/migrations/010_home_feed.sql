-- =====================================================================
-- XGo Plus — 010 home feed
-- One public call returns the home page rows:
--   top:  10 best discounts, spread across categories (best of each category first)
--   rows: up to 5 categories (admin order), each with its 10 best discounts
-- Optional area filter. Idempotent. Run after 009.
-- =====================================================================

create or replace function public.home_feed(p_area uuid default null, p_top int default 10, p_rows int default 5, p_per_row int default 10)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_top int := least(greatest(coalesce(p_top, 10), 1), 20);
  v_rows int := least(greatest(coalesce(p_rows, 5), 0), 10);
  v_per int := least(greatest(coalesce(p_per_row, 10), 1), 20);
  v_res jsonb;
begin
  with base as (
    select p.id, p.name, p.image_path, p.discount_percent, p.category_id, p.sort_order, a.name as area_name,
           row_number() over (partition by coalesce(p.category_id, p.id)
                              order by p.discount_percent desc, p.sort_order, p.name, p.id) as rk
    from public.providers p
    left join public.areas a on a.id = p.area_id
    where p.is_active and (p_area is null or p.area_id = p_area)
  ),
  top as (
    select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'image_path', image_path,
                                        'discount_percent', discount_percent, 'area_name', area_name) order by ord) as items
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
                                                           'discount_percent', b.discount_percent, 'area_name', b.area_name)
                                        order by b.rk)
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

create index if not exists providers_cat_disc on public.providers (category_id, discount_percent desc) where is_active;

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
