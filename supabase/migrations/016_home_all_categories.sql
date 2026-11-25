-- =====================================================================
-- XGo Plus — 016 home page: a row for every category that has partners
-- home_feed() used to cap category rows at 10 (the site asked for 5); it
-- now returns every active category with at least one active partner
-- (up to 100), still max p_per_row partners per row. Idempotent. Run after 015.
-- =====================================================================

create or replace function public.home_feed(p_area uuid default null, p_top int default 10, p_rows int default 5, p_per_row int default 10)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_top int := least(greatest(coalesce(p_top, 10), 1), 20);
  v_rows int := least(greatest(coalesce(p_rows, 100), 0), 100);
  v_per int := least(greatest(coalesce(p_per_row, 10), 1), 20);
  v_area_name text := (select name from public.areas where id = p_area);
  v_res jsonb;
begin
  with base as (
    select p.id, p.name, p.image_path, p.discount_percent, p.max_percent, p.offer_label, p.category_id, p.sort_order,
           coalesce(v_area_name, a.name) as area_name, cardinality(p.area_ids) as areas_count,
           row_number() over (partition by coalesce(p.category_id, p.id)
                              order by p.max_percent desc, p.sort_order, p.name, p.id) as rk
    from public.providers p
    left join public.areas a on a.id = p.area_id
    where p.is_active and (p_area is null or p_area = any (p.area_ids))
  ),
  top as (
    select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'image_path', image_path, 'discount_percent', discount_percent,
                                        'max_percent', max_percent, 'offer_label', offer_label, 'area_name', area_name, 'areas_count', areas_count) order by ord) as items
    from (select *, row_number() over (order by rk, max_percent desc, sort_order, name, id) as ord from base) x
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
                                                           'discount_percent', b.discount_percent, 'max_percent', b.max_percent, 'offer_label', b.offer_label,
                                                           'area_name', b.area_name, 'areas_count', b.areas_count) order by b.rk)
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

create or replace function public.schema_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'version', 16,
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
    'm016', position('coalesce(p_rows, 100)' in pg_get_functiondef('public.home_feed(uuid, integer, integer, integer)'::regprocedure)) > 0)
$$;
