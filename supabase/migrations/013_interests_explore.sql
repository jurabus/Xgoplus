-- =====================================================================
-- XGo Plus — 013 member interests + Explore (targeted ads)
-- Interests: every counted scan at a partner counts for that partner's
--   category; interest % = category scans / all lifetime scans of the member.
--   Admin-only reports (summary per category, ranking, one member).
-- Explore: admin posts ads (large image, text, optional "Visit us" link),
--   each with a category. A member sees an ad when their interest in that
--   category is >= the ad's minimum % (default from settings, 40%) and they
--   have at least N lifetime scans (settings). Ads marked "show to everyone"
--   are also shown to all others after the targeted ones.
--   Explore is OFF until switched on in Admin → Modules (opt-in module).
--   Unique daily views and clicks are tracked per ad.
-- Idempotent. Run after 012.
-- =====================================================================

create index if not exists scans_member_counted on public.scans (member_id, provider_id) where counted and member_id is not null;

-- settings (texts & settings JSON) with defaults
create or replace function private.setting_num(p_key text, p_default numeric) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(case when (select data->>p_key from public.settings where id = 1) ~ '^[0-9]+(\.[0-9]+)?$'
                       then (select (data->>p_key)::numeric from public.settings where id = 1) end, p_default)
$$;
create or replace function private.explore_on() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select (data->'app_enabled_modules') ? 'explore'
                          and not coalesce((data->'app_disabled_modules') ? 'explore', false)
                   from public.settings where id = 1), false)
$$;

-- ---------------------------------------------------------------------
-- interests
-- ---------------------------------------------------------------------
create or replace function private.member_interests(p_uid uuid)
returns table (category_id uuid, scans int, total int, pct numeric)
language sql stable security definer set search_path = '' as $$
  with s as (
    select p.category_id
    from public.scans sc join public.providers p on p.id = sc.provider_id
    where sc.member_id = p_uid and sc.counted
  ), t as (select count(*)::int as n from s)
  select s.category_id, count(*)::int, t.n, round(100.0 * count(*) / nullif(t.n, 0), 1)
  from s, t
  where s.category_id is not null
  group by s.category_id, t.n
$$;

-- all members' scores in one pass (admin reports + ad audiences)
create or replace function private.interest_scores()
returns table (member_id uuid, category_id uuid, scans int, total int, pct numeric)
language sql stable security definer set search_path = '' as $$
  with s as (
    select sc.member_id, p.category_id
    from public.scans sc join public.providers p on p.id = sc.provider_id
    where sc.counted and sc.member_id is not null
  ), t as (select member_id, count(*)::int as n from s group by member_id)
  select s.member_id, s.category_id, count(*)::int, t.n, round(100.0 * count(*) / t.n, 1)
  from s join t using (member_id)
  where s.category_id is not null
  group by s.member_id, s.category_id, t.n
$$;

create or replace function public.admin_interest_summary(p_min_pct numeric default null, p_min_scans int default null)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_pct numeric := coalesce(p_min_pct, private.setting_num('explore_min_pct', 40));
  v_min int := coalesce(p_min_scans, private.setting_num('explore_min_scans', 1)::int);
  v_res jsonb;
begin
  if private.admin_denied('admin_interest_summary') then return null; end if;
  with sc as (select * from private.interest_scores()),
  all_scans as (select count(*)::numeric as n from public.scans where counted and member_id is not null)
  select jsonb_build_object(
    'min_pct', v_pct, 'min_scans', v_min,
    'members_with_scans', (select count(distinct member_id) from public.scans where counted and member_id is not null),
    'total_scans', (select n from all_scans),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'icon', c.icon, 'is_active', c.is_active,
        'scans', coalesce(x.scans, 0),
        'share', case when (select n from all_scans) > 0 then round(100 * coalesce(x.scans, 0) / (select n from all_scans), 1) else 0 end,
        'members', coalesce(x.members, 0),
        'interested', coalesce(x.interested, 0),
        'avg_pct', x.avg_pct)
        order by coalesce(x.scans, 0) desc, c.sort_order, c.name)
      from public.categories c
      left join (select category_id, sum(scans)::int as scans, count(*)::int as members,
                        count(*) filter (where pct >= v_pct and total >= v_min)::int as interested,
                        round(avg(pct), 1) as avg_pct
                 from sc group by category_id) x on x.category_id = c.id), '[]'::jsonb))
  into v_res;
  return v_res;
end $$;
revoke all on function public.admin_interest_summary(numeric, int) from public;
grant execute on function public.admin_interest_summary(numeric, int) to anon, authenticated;

create or replace function public.admin_interest_members(p_category uuid, p_min_pct numeric default 0, p_limit int default 50, p_offset int default 0)
returns table (member_id uuid, first_name text, last_name text, phone text, scans int, total int, pct numeric)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_interest_members') then return; end if;
  return query
    select s.member_id, pr.first_name, pr.last_name, pr.phone, s.scans, s.total, s.pct
    from private.interest_scores() s join public.profiles pr on pr.id = s.member_id
    where s.category_id = p_category and s.pct >= coalesce(p_min_pct, 0)
    order by s.pct desc, s.scans desc, pr.first_name
    limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;
revoke all on function public.admin_interest_members(uuid, numeric, int, int) from public;
grant execute on function public.admin_interest_members(uuid, numeric, int, int) to anon, authenticated;

create or replace function public.admin_member_interests(p_user uuid)
returns table (category_id uuid, name text, scans int, total int, pct numeric)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_member_interests') then return; end if;
  return query
    select i.category_id, c.name, i.scans, i.total, i.pct
    from private.member_interests(p_user) i join public.categories c on c.id = i.category_id
    order by i.pct desc, c.name;
end $$;
revoke all on function public.admin_member_interests(uuid) from public;
grant execute on function public.admin_member_interests(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Explore ads
-- ---------------------------------------------------------------------
create table if not exists public.explore_ads (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.categories(id) on delete set null,
  advertiser text not null check (length(advertiser) between 1 and 80),
  logo_path text check (logo_path is null or length(logo_path) <= 300),
  body text not null default '' check (length(body) <= 2000),
  image_path text not null check (length(image_path) between 1 and 300),
  link_url text check (link_url is null or (length(link_url) <= 500 and link_url ~ '^https://[^\s/]+\.[^\s]+$')),
  cta_label text not null default '' check (length(cta_label) <= 30),
  min_pct numeric(5,2) check (min_pct is null or (min_pct >= 0 and min_pct <= 100)),
  show_to_all boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint explore_ads_dates check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create index if not exists explore_ads_live on public.explore_ads (category_id) where is_active;
alter table public.explore_ads enable row level security;
revoke all on public.explore_ads from anon, authenticated;
grant select, insert, update, delete on public.explore_ads to authenticated;   -- admin only (policies)
drop policy if exists explore_ads_admin on public.explore_ads;
create policy explore_ads_admin on public.explore_ads for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create or replace function private.explore_ads_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.advertiser := private.clean_name(new.advertiser);
  new.cta_label := private.clean_name(coalesce(new.cta_label, ''));
  new.body := btrim(coalesce(new.body, ''));                         -- shown as plain text only
  new.link_url := nullif(btrim(coalesce(new.link_url, '')), '');
  if length(new.advertiser) = 0 then raise exception 'advertiser_required'; end if;
  return new;
end $$;
drop trigger if exists explore_ads_guard on public.explore_ads;
create trigger explore_ads_guard before insert or update on public.explore_ads
  for each row execute function private.explore_ads_guard();

create table if not exists public.explore_events (
  id bigint generated always as identity primary key,
  ad_id uuid not null references public.explore_ads(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('view', 'click')),
  day date not null default ((now() at time zone 'Africa/Cairo')::date),
  created_at timestamptz not null default now(),
  unique (ad_id, user_id, kind, day)
);
create index if not exists explore_events_ad on public.explore_events (ad_id, kind);
alter table public.explore_events enable row level security;
revoke all on public.explore_events from anon, authenticated;

-- ads a member qualifies for, best match first
create or replace function private.explore_ads_for(p_uid uuid)
returns table (ad_id uuid, targeted boolean, score numeric)
language sql stable security definer set search_path = '' as $$
  with me as (select * from private.member_interests(p_uid)),
  tot as (select coalesce(max(total), 0) as n from me),
  live as (
    select a.* from public.explore_ads a
    where a.is_active and (a.starts_at is null or a.starts_at <= now()) and (a.ends_at is null or a.ends_at > now())
  )
  select l.id,
         (m.pct is not null and m.pct >= coalesce(l.min_pct, private.setting_num('explore_min_pct', 40))
            and (select n from tot) >= private.setting_num('explore_min_scans', 1)),
         coalesce(m.pct, 0)
  from live l
  left join me m on m.category_id = l.category_id
  where l.show_to_all
     or (l.category_id is not null and m.pct is not null
         and m.pct >= coalesce(l.min_pct, private.setting_num('explore_min_pct', 40))
         and (select n from tot) >= private.setting_num('explore_min_scans', 1))
$$;

create or replace function public.explore_feed(p_limit int default 20, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if not private.explore_on() then return jsonb_build_object('enabled', false, 'items', '[]'::jsonb); end if;
  return jsonb_build_object('enabled', true, 'items', coalesce((
    select jsonb_agg(x.j order by x.targeted desc, x.score desc, x.sort_order, x.created_at desc)
    from (
      select jsonb_build_object('id', a.id, 'advertiser', a.advertiser, 'logo_path', a.logo_path, 'body', a.body,
               'image_path', a.image_path, 'link_url', a.link_url, 'cta_label', a.cta_label,
               'category', c.name, 'category_icon', c.icon, 'created_at', a.created_at, 'targeted', f.targeted) as j,
             f.targeted, f.score, a.sort_order, a.created_at
      from (select * from private.explore_ads_for(v_uid) where v_uid is not null
            union all
            select a2.id, false, 0 from public.explore_ads a2
            where v_uid is null and a2.show_to_all and a2.is_active
              and (a2.starts_at is null or a2.starts_at <= now()) and (a2.ends_at is null or a2.ends_at > now())) f
      join public.explore_ads a on a.id = f.ad_id
      left join public.categories c on c.id = a.category_id
      order by f.targeted desc, f.score desc, a.sort_order, a.created_at desc
      limit least(greatest(coalesce(p_limit, 20), 1), 50) offset greatest(coalesce(p_offset, 0), 0)
    ) x), '[]'::jsonb));
end $$;
revoke all on function public.explore_feed(int, int) from public;
grant execute on function public.explore_feed(int, int) to anon, authenticated;

create or replace function public.explore_track(p_ad uuid, p_kind text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or p_kind not in ('view', 'click') or not private.explore_on() then return false; end if;
  if not private.hit_rate_limit('explore', v_uid::text, 300, 3600) then return false; end if;
  if not exists (select 1 from private.explore_ads_for(v_uid) f where f.ad_id = p_ad) then return false; end if;
  insert into public.explore_events (ad_id, user_id, kind) values (p_ad, v_uid, p_kind)
  on conflict (ad_id, user_id, kind, day) do nothing;
  return true;
end $$;
revoke all on function public.explore_track(uuid, text) from public, anon;
grant execute on function public.explore_track(uuid, text) to authenticated;

-- audience size for a category + threshold (ad editor preview)
create or replace function public.admin_ad_audience(p_category uuid, p_min_pct numeric default null) returns int
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_ad_audience') then return null; end if;
  return (select count(*) from private.interest_scores() s
          where s.category_id = p_category
            and s.pct >= coalesce(p_min_pct, private.setting_num('explore_min_pct', 40))
            and s.total >= private.setting_num('explore_min_scans', 1));
end $$;
revoke all on function public.admin_ad_audience(uuid, numeric) from public;
grant execute on function public.admin_ad_audience(uuid, numeric) to anon, authenticated;

-- per-ad results
create or replace function public.admin_explore_stats()
returns table (ad_id uuid, views bigint, reach bigint, clicks bigint, audience int)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.admin_denied('admin_explore_stats') then return; end if;
  return query
    with sc as (select * from private.interest_scores())
    select a.id,
           (select count(*) from public.explore_events e where e.ad_id = a.id and e.kind = 'view'),
           (select count(distinct e.user_id) from public.explore_events e where e.ad_id = a.id and e.kind = 'view'),
           (select count(distinct e.user_id) from public.explore_events e where e.ad_id = a.id and e.kind = 'click'),
           (select count(*)::int from sc where sc.category_id = a.category_id
              and sc.pct >= coalesce(a.min_pct, private.setting_num('explore_min_pct', 40))
              and sc.total >= private.setting_num('explore_min_scans', 1))
    from public.explore_ads a;
end $$;
revoke all on function public.admin_explore_stats() from public;
grant execute on function public.admin_explore_stats() to anon, authenticated;

create or replace function public.schema_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'version', 13,
    'm005', to_regclass('public.categories') is not null,
    'm006', to_regclass('public.complaints') is not null,
    'm007', to_regclass('public.areas') is not null,
    'm008', to_regclass('public.membership_requests') is not null,
    'm009', to_regclass('public.trials') is not null,
    'm010', to_regprocedure('public.home_feed(uuid, integer, integer, integer)') is not null,
    'm011', to_regclass('public.branches') is not null,
    'm012', to_regclass('public.discount_rules') is not null,
    'm013', to_regclass('public.explore_ads') is not null)
$$;
