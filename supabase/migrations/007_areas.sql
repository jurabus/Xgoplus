-- =====================================================================
-- XGo Plus — 007 areas (e.g. 6th of October, Sheikh Zayed)
-- - areas table (admin-managed), providers.area_id (admin assigns)
-- - search_providers gets p_area and returns area_name
-- - usage limit weeks now start on SUNDAY (Cairo time)
-- Idempotent. Run after 006.
-- =====================================================================

create table if not exists public.areas (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 60),
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists areas_active_sort on public.areas (is_active, sort_order, name);
alter table public.areas enable row level security;
revoke all on public.areas from anon, authenticated;
grant select (id, name, sort_order, is_active) on public.areas to anon, authenticated;
grant insert (name, sort_order, is_active), update (name, sort_order, is_active), delete on public.areas to authenticated;

drop policy if exists areas_read on public.areas;
create policy areas_read on public.areas for select to anon, authenticated
  using (is_active or (select public.is_admin()));
drop policy if exists areas_admin_insert on public.areas;
create policy areas_admin_insert on public.areas for insert to authenticated with check ((select public.is_admin()));
drop policy if exists areas_admin_update on public.areas;
create policy areas_admin_update on public.areas for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists areas_admin_delete on public.areas;
create policy areas_admin_delete on public.areas for delete to authenticated using ((select public.is_admin()));

create or replace function private.areas_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.name := private.clean_name(new.name);
  if length(new.name) = 0 then raise exception 'invalid_name'; end if;
  return new;
end $$;
drop trigger if exists areas_guard on public.areas;
create trigger areas_guard before insert or update on public.areas
  for each row execute function private.areas_guard();

insert into public.areas (name, sort_order)
select * from (values ('6th of October', 10), ('Sheikh Zayed', 20)) v(name, sort_order)
where not exists (select 1 from public.areas);

alter table public.providers add column if not exists area_id uuid references public.areas(id) on delete set null;
create index if not exists providers_area on public.providers (area_id, discount_percent desc) where is_active;
grant select (area_id) on public.providers to anon, authenticated;

-- Admin patch now also handles area_id
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
    category_id = case when p_patch ? 'category_id' then nullif(p_patch->>'category_id', '')::uuid else category_id end,
    area_id = case when p_patch ? 'area_id' then nullif(p_patch->>'area_id', '')::uuid else area_id end,
    limit_count = case when p_patch ? 'limit_count' then (p_patch->>'limit_count')::smallint else limit_count end,
    limit_period = case when p_patch ? 'limit_period' then nullif(p_patch->>'limit_period', '') else limit_period end,
    allowed_days = case when p_patch ? 'allowed_days' then
      (case when jsonb_typeof(p_patch->'allowed_days') = 'array'
            then (select array_agg(x::smallint) from jsonb_array_elements_text(p_patch->'allowed_days') x) end)
      else allowed_days end
  where id = p_id;
  if not found then raise exception 'not_found'; end if;
end $$;
revoke all on function public.admin_update_provider(uuid, jsonb) from public, anon;
grant execute on function public.admin_update_provider(uuid, jsonb) to authenticated;

create or replace function public.admin_area_counts() returns table (area_id uuid, providers bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_admin();
  return query select p.area_id, count(*) from public.providers p where p.area_id is not null group by p.area_id;
end $$;
revoke all on function public.admin_area_counts() from public, anon;
grant execute on function public.admin_area_counts() to authenticated;

-- Provider context (partner portal) shows their area
create or replace function public.get_my_context() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_profile jsonb; v_provider jsonb; v_admin boolean;
begin
  if v_uid is null then return jsonb_build_object('role', 'guest'); end if;
  v_admin := public.is_admin();
  select to_jsonb(p) - 'updated_at' into v_profile from public.profiles p where p.id = v_uid;
  select jsonb_build_object('id', p.id, 'username', p.username, 'name', p.name, 'image_path', p.image_path,
                            'discount_percent', p.discount_percent, 'notes', p.notes, 'is_active', p.is_active,
                            'area_name', a.name)
    into v_provider from public.providers p left join public.areas a on a.id = p.area_id where p.user_id = v_uid;
  return jsonb_build_object(
    'role', case when v_admin then 'admin'
                 when v_provider is not null and (v_provider->>'is_active')::boolean then 'provider'
                 when v_profile is not null then 'customer' else 'none' end,
    'is_admin', v_admin,
    'profile', v_profile,
    'provider', v_provider,
    'membership', case when v_profile is not null then private.membership_state(v_uid) end
  );
end $$;
revoke all on function public.get_my_context() from public;
grant execute on function public.get_my_context() to anon, authenticated;

-- ---------------------------------------------------------------------
-- Weeks start on Sunday for usage limits
-- ---------------------------------------------------------------------
create or replace function private.period_start(p_period text, p_local timestamp) returns timestamp
language sql immutable set search_path = '' as $$
  select case when p_period = 'week'
              then date_trunc('day', p_local) - make_interval(days => extract(dow from p_local)::int)   -- back to Sunday
              else date_trunc(p_period, p_local) end
$$;

create or replace function private.usage_state(p_uid uuid, p_pid uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_p record;
  v_local timestamp := now() at time zone 'Africa/Cairo';
  v_start timestamptz; v_reset timestamptz; v_used int := 0; v_today boolean; v_ps timestamp;
begin
  select limit_count, limit_period, allowed_days into v_p from public.providers where id = p_pid;
  v_today := v_p.allowed_days is null or extract(dow from v_local)::smallint = any (v_p.allowed_days);
  if v_p.limit_count is not null then
    v_ps := private.period_start(v_p.limit_period, v_local);
    v_start := v_ps at time zone 'Africa/Cairo';
    v_reset := (v_ps + ('1 ' || v_p.limit_period)::interval) at time zone 'Africa/Cairo';
    select count(*) into v_used from public.scans s
     where s.member_id = p_uid and s.provider_id = p_pid and s.counted and s.created_at >= v_start;
  end if;
  return jsonb_build_object(
    'limit_count', v_p.limit_count, 'limit_period', v_p.limit_period, 'allowed_days', to_jsonb(v_p.allowed_days),
    'used', v_used, 'uses_left', case when v_p.limit_count is not null then greatest(v_p.limit_count - v_used, 0) end,
    'resets_at', v_reset, 'valid_today', v_today);
end $$;

-- ---------------------------------------------------------------------
-- Search: area filter + area name in results
-- ---------------------------------------------------------------------
drop function if exists public.search_providers(text, uuid, int, int, numeric);
drop function if exists public.search_providers(text, uuid, int, int, numeric, uuid);
create or replace function public.search_providers(
  p_q text, p_category uuid default null, p_limit int default 20, p_offset int default 0,
  p_min_discount numeric default null, p_area uuid default null
) returns table (id uuid, name text, image_path text, discount_percent numeric, category_id uuid, area_id uuid, area_name text)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_q text := private.norm(left(coalesce(p_q, ''), 60));
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 20);
begin
  if length(v_q) = 0 then return; end if;
  return query
    select p.id, p.name, p.image_path, p.discount_percent, p.category_id, p.area_id, a.name
    from public.providers p
    left join public.categories c on c.id = p.category_id and c.is_active
    left join public.areas a on a.id = p.area_id
    where p.is_active
      and (p_category is null or p.category_id = p_category)
      and (p_area is null or p.area_id = p_area)
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

-- Starter categories: switch the original emojis to the new line-icon set (only if unchanged)
update public.categories set icon = v.new_icon
from (values ('☕', 'i:cafe'), ('🍽️', 'i:food'), ('🏋️', 'i:gym'), ('🩺', 'i:doc'), ('💅', 'i:salon'), ('🛍️', 'i:shop'))
     v(old_icon, new_icon)
where public.categories.icon = v.old_icon;
