-- =====================================================================
-- XGo Plus — 015 offer types + validity dates
-- Every offer (time window, first visit, service) now has a value type:
--   percent : 20%                       (as before)
--   deal    : free text, e.g. "Buy 2 Get 1"
--   price   : special price, e.g. 950 EGP instead of 1200
-- and optional "valid from / until" dates (Egypt dates, inclusive), e.g.
-- "until the last day of the month". Expired or future offers are hidden
-- and ignored at checkout.
-- providers.max_percent now counts special prices by their saving
-- (950 instead of 1200 = 20.8%); providers.offer_label shows a deal on the
-- card when a partner has no % at all ("Buy 2 Get 1").
-- Idempotent. Run after 014.
-- =====================================================================

alter table public.discount_rules add column if not exists value_type text not null default 'percent';
alter table public.discount_rules add column if not exists deal_text text not null default '';
alter table public.discount_rules add column if not exists price_new numeric(10,2);
alter table public.discount_rules add column if not exists price_old numeric(10,2);
alter table public.discount_rules add column if not exists starts_on date;
alter table public.discount_rules add column if not exists ends_on date;
alter table public.discount_rules alter column percent drop not null;
alter table public.discount_rules drop constraint if exists discount_rules_percent_check;
alter table public.discount_rules drop constraint if exists discount_rules_value_check;
alter table public.discount_rules add constraint discount_rules_value_check check (
  case value_type
    when 'percent' then percent is not null and percent > 0 and percent <= 100
    when 'deal' then length(btrim(deal_text)) between 1 and 60
    when 'price' then price_new > 0 and price_old > price_new and price_old <= 10000000
    else false end);
alter table public.discount_rules drop constraint if exists discount_rules_dates_check;
alter table public.discount_rules add constraint discount_rules_dates_check check (ends_on is null or starts_on is null or ends_on >= starts_on);
grant select (value_type, deal_text, price_new, price_old, starts_on, ends_on) on public.discount_rules to anon, authenticated;
grant insert (value_type, deal_text, price_new, price_old, starts_on, ends_on),
      update (value_type, deal_text, price_new, price_old, starts_on, ends_on) on public.discount_rules to authenticated;

create or replace function private.cairo_today() returns date
language sql stable set search_path = '' as $$ select (now() at time zone 'Africa/Cairo')::date $$;

create or replace function private.rule_live(p_active boolean, p_from date, p_to date) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(p_active, false) and (p_from is null or p_from <= private.cairo_today()) and (p_to is null or p_to >= private.cairo_today())
$$;

-- % used for "Up to" and sorting: the % itself, or the saving of a special price; deals have none
create or replace function private.rule_pct(r public.discount_rules) returns numeric
language sql immutable set search_path = '' as $$
  select case r.value_type
    when 'percent' then r.percent
    when 'price' then round(100 * (r.price_old - r.price_new) / nullif(r.price_old, 0), 1) end
$$;

create or replace function private.rule_json(r public.discount_rules) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('title', r.title, 'value_type', r.value_type, 'percent', r.percent, 'deal_text', r.deal_text,
                            'price_new', r.price_new, 'price_old', r.price_old, 'ends_on', r.ends_on)
$$;

create or replace function private.discount_rules_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.title := private.clean_name(coalesce(new.title, ''));
  new.deal_text := private.clean_name(coalesce(new.deal_text, ''));
  if new.value_type <> 'percent' then new.percent := null; end if;
  if new.value_type <> 'deal' then new.deal_text := ''; end if;
  if new.value_type <> 'price' then new.price_new := null; new.price_old := null; end if;
  if new.kind <> 'time' then new.start_time := null; new.end_time := null; new.days := null; end if;
  if new.days is not null then
    new.days := (select array_agg(distinct d order by d) from unnest(new.days) d);
    if cardinality(new.days) = 7 then new.days := null; end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- best % + card label
-- ---------------------------------------------------------------------
alter table public.providers add column if not exists offer_label text;
grant select (offer_label) on public.providers to anon, authenticated;

create or replace function private.provider_max_percent(p_id uuid, p_base numeric) returns numeric
language sql stable security definer set search_path = '' as $$
  select greatest(coalesce(p_base, 0),
                  coalesce((select max(private.rule_pct(r)) from public.discount_rules r
                            where r.provider_id = p_id and private.rule_live(r.is_active, r.starts_on, r.ends_on)), 0))
$$;

create or replace function private.provider_offer_label(p_id uuid, p_base numeric) returns text
language sql stable security definer set search_path = '' as $$
  select case when private.provider_max_percent(p_id, p_base) > 0 then null else
    (select r.deal_text from public.discount_rules r
      where r.provider_id = p_id and r.value_type = 'deal' and private.rule_live(r.is_active, r.starts_on, r.ends_on)
      order by r.sort_order, r.created_at limit 1) end
$$;

create or replace function private.providers_max_percent() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.max_percent := private.provider_max_percent(new.id, new.discount_percent);
  new.offer_label := private.provider_offer_label(new.id, new.discount_percent);
  return new;
end $$;

create or replace function private.sync_provider_offers(p_ids uuid[]) returns void
language sql security definer set search_path = '' as $$
  update public.providers p
     set max_percent = private.provider_max_percent(p.id, p.discount_percent),
         offer_label = private.provider_offer_label(p.id, p.discount_percent)
   where p.id = any (p_ids)
     and (p.max_percent is distinct from private.provider_max_percent(p.id, p.discount_percent)
          or p.offer_label is distinct from private.provider_offer_label(p.id, p.discount_percent))
$$;

create or replace function private.discount_rules_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.sync_provider_offers(array_remove(array[case when tg_op <> 'INSERT' then old.provider_id end,
                                                          case when tg_op <> 'DELETE' then new.provider_id end], null));
  return null;
end $$;

-- offers with dates start and end without anyone editing them: re-check at most once an hour
-- (called by scans, the listener heartbeat and page visits)
create table if not exists private.job_runs (name text primary key, last_run timestamptz not null);
create or replace function private.refresh_offers() returns void
language plpgsql security definer set search_path = '' as $$
declare v_last timestamptz;
begin
  select last_run into v_last from private.job_runs where name = 'offers';
  if v_last is not null and v_last > now() - interval '1 hour' then return; end if;
  insert into private.job_runs (name, last_run) values ('offers', now())
  on conflict (name) do update set last_run = now() where private.job_runs.last_run <= now() - interval '1 hour';
  if not found then return; end if;     -- someone else just did it
  perform private.sync_provider_offers(array(select distinct provider_id from public.discount_rules
                                               where starts_on is not null or ends_on is not null));
end $$;
create or replace function public.refresh_offers() returns void
language sql security definer set search_path = '' as $$ select private.refresh_offers() $$;
revoke all on function public.refresh_offers() from public;
grant execute on function public.refresh_offers() to anon, authenticated;

select private.sync_provider_offers(array(select id from public.providers));

-- time windows: percent offers only for the automatic pick; shared matcher
create or replace function private.time_rule_matches(p_from time, p_to time, p_days smallint[]) returns boolean
language sql stable set search_path = '' as $$
  with n as (select (now() at time zone 'Africa/Cairo') as t)
  select (p_days is null or extract(dow from n.t)::smallint = any (p_days))
     and case when p_from < p_to then n.t::time >= p_from and n.t::time < p_to
              else n.t::time >= p_from or n.t::time < p_to end
  from n
$$;

create or replace function private.time_rule_now(p_provider uuid)
returns table (percent numeric, title text, start_time time, end_time time)
language sql stable security definer set search_path = '' as $$
  select r.percent, r.title, r.start_time, r.end_time
  from public.discount_rules r
  where r.provider_id = p_provider and r.kind = 'time' and r.value_type = 'percent'
    and private.rule_live(r.is_active, r.starts_on, r.ends_on)
    and private.time_rule_matches(r.start_time, r.end_time, r.days)
  order by r.percent desc
  limit 1
$$;

-- the listener phone checks in every 15 minutes: good moment to refresh dated offers
create or replace function public.sms_heartbeat(p_token text, p_info text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_dev uuid := private.device_for(p_token);
begin
  if v_dev is null then raise exception 'device_revoked'; end if;
  if not private.hit_rate_limit('smsbeat', v_dev::text, 120, 3600) then raise exception 'rate_limited'; end if;
  update private.sms_devices set last_seen_at = now(), last_info = left(coalesce(p_info, ''), 200) where id = v_dev;
  perform private.refresh_offers();
  return jsonb_build_object('enabled', private.autopay_on(), 'server_time', now());
end $$;

-- ---------------------------------------------------------------------
-- scan: pick the best % now; list services (any type) and deals/prices that apply now
-- ---------------------------------------------------------------------
create or replace function public.verify_member_qr(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_pid uuid := public.my_provider_id();
  v_provider record;
  v_m text[];
  v_uid uuid;
  v_ts bigint;
  v_now bigint := floor(extract(epoch from now()))::bigint;
  v_profile record;
  v_state jsonb;
  v_usage jsonb;
  v_label text;
  v_result text;
  v_counted boolean := false;
  v_repeat boolean := false;
  v_trial record;
  v_use_trial boolean := false;
  v_tpct numeric;
  v_ttitle text;
  v_tfrom time;
  v_tto time;
  v_first numeric;
  v_is_first boolean := false;
  v_pct numeric;
  v_kind text;
  v_services jsonb;
  v_extras jsonb := '[]'::jsonb;
begin
  if v_pid is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.hit_rate_limit('scan', v_pid::text, 30, 60) then raise exception 'rate_limited'; end if;
  select id, name, discount_percent, notes, limit_count, limit_period, allowed_days into v_provider
    from public.providers where id = v_pid;

  v_m := regexp_match(btrim(coalesce(p_token, '')), 'XG1\.([0-9a-f]{32})\.([0-9]{9,11})\.([0-9a-f]{32})');
  if v_m is null then
    insert into public.scans (provider_id, result) values (v_pid, 'invalid');
    return jsonb_build_object('status', 'invalid');
  end if;
  v_uid := v_m[1]::uuid;
  if private.sign_qr('XG1.' || v_m[1] || '.' || v_m[2] || '|' || private.active_sid(v_uid)) <> v_m[3] then
    insert into public.scans (provider_id, result) values (v_pid, 'invalid');
    return jsonb_build_object('status', 'invalid');
  end if;
  v_ts := v_m[2]::bigint;
  if v_ts < v_now - 180 or v_ts > v_now + 60 then
    insert into public.scans (provider_id, result) values (v_pid, 'stale');
    return jsonb_build_object('status', 'stale');
  end if;
  select id, first_name, last_name into v_profile from public.profiles where id = v_uid;
  if v_profile.id is null then
    insert into public.scans (provider_id, result) values (v_pid, 'invalid');
    return jsonb_build_object('status', 'invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));   -- per member: no double-spend anywhere
  v_label := v_profile.first_name || ' ' || left(v_profile.last_name, 1) || '.';
  v_state := private.membership_state(v_uid);
  v_usage := private.usage_state(v_uid, v_pid);
  select * into v_trial from public.trials where user_id = v_uid;

  if v_state->>'status' <> 'active' then
    if v_trial.user_id is not null and v_trial.used_at is null then
      v_use_trial := true;
    elsif v_trial.used_at is not null and v_trial.used_provider = v_pid and v_trial.used_at > now() - interval '15 minutes' then
      v_use_trial := true;                                              -- same checkout re-scanned
    else
      v_result := case when v_trial.user_id is not null then 'trial_used' else 'expired' end;
    end if;
  end if;

  if v_result is null then
    if not (v_usage->>'valid_today')::boolean then
      v_result := 'not_today';
    elsif exists (select 1 from public.scans s where s.provider_id = v_pid and s.member_id = v_uid and s.counted
                    and s.created_at > now() - interval '15 minutes') then
      v_result := 'active'; v_repeat := true;
    elsif v_provider.limit_count is not null and (v_usage->>'uses_left')::int <= 0 then
      v_result := 'limit_reached';
    else
      v_result := 'active'; v_counted := true;
    end if;
  end if;

  perform private.refresh_offers();
  -- services are always shown (the partner applies them per service): %, a deal text or a special price
  select coalesce(jsonb_agg(private.rule_json(r) order by r.sort_order, private.rule_pct(r) desc nulls last, r.title), '[]'::jsonb)
    into v_services from public.discount_rules r
   where r.provider_id = v_pid and r.kind = 'service' and private.rule_live(r.is_active, r.starts_on, r.ends_on);

  if v_result = 'active' then
    v_pct := v_provider.discount_percent; v_kind := 'standard';
    select t.percent, t.title, t.start_time, t.end_time into v_tpct, v_ttitle, v_tfrom, v_tto from private.time_rule_now(v_pid) t;
    if v_tpct is not null and v_tpct > v_pct then v_pct := v_tpct; v_kind := 'time'; end if;
    select r.percent into v_first from public.discount_rules r
     where r.provider_id = v_pid and r.kind = 'first' and r.value_type = 'percent' and private.rule_live(r.is_active, r.starts_on, r.ends_on);
    v_is_first := not exists (select 1 from public.scans s where s.provider_id = v_pid and s.member_id = v_uid and s.counted
                                and s.created_at <= now() - interval '15 minutes');
    -- deals / special prices that apply right now (time window or first visit) are listed for the cashier
    select coalesce(jsonb_agg(private.rule_json(r) || jsonb_build_object('kind', r.kind,
             'from', to_char(r.start_time, 'HH24:MI'), 'to', to_char(r.end_time, 'HH24:MI')) order by r.sort_order), '[]'::jsonb)
      into v_extras from public.discount_rules r
     where r.provider_id = v_pid and r.value_type <> 'percent' and private.rule_live(r.is_active, r.starts_on, r.ends_on)
       and ((r.kind = 'first' and v_is_first) or (r.kind = 'time' and private.time_rule_matches(r.start_time, r.end_time, r.days)));
    if v_first is not null then
      if v_is_first and v_first > v_pct then v_pct := v_first; v_kind := 'first'; end if;
    end if;
  end if;

  insert into public.scans (provider_id, member_id, member_label, result, discount_percent, discount_kind, counted, trial)
  values (v_pid, v_uid, v_label, v_result, v_pct, v_kind, v_counted, v_use_trial and v_result = 'active');
  if v_counted and v_use_trial then
    update public.trials set used_at = now(), used_provider = v_pid where user_id = v_uid and used_at is null;
  end if;
  if v_counted then v_usage := private.usage_state(v_uid, v_pid); end if;

  return jsonb_build_object(
    'status', v_result,
    'member_name', v_label,
    'expires_at', v_state->'expires_at',
    'discount_percent', v_pct,
    'discount_kind', v_kind,
    'standard_percent', v_provider.discount_percent,
    'time_title', case when v_kind = 'time' then v_ttitle end,
    'time_from', case when v_kind = 'time' then to_char(v_tfrom, 'HH24:MI') end,
    'time_to', case when v_kind = 'time' then to_char(v_tto, 'HH24:MI') end,
    'services', case when v_result = 'active' then v_services else '[]'::jsonb end,
    'extras', case when v_result = 'active' then v_extras else '[]'::jsonb end,
    'provider_name', v_provider.name,
    'notes', v_provider.notes,
    'repeat', v_repeat,
    'trial', v_use_trial and v_result = 'active',
    'usage', v_usage,
    'checked_at', now()
  );
end $$;
revoke all on function public.verify_member_qr(text) from public, anon;
grant execute on function public.verify_member_qr(text) to authenticated;

-- search + home feed: card label for deal-only partners
drop function if exists public.search_providers(text, uuid, int, int, numeric, uuid);
create or replace function public.search_providers(
  p_q text, p_category uuid default null, p_limit int default 20, p_offset int default 0,
  p_min_discount numeric default null, p_area uuid default null
) returns table (id uuid, name text, image_path text, discount_percent numeric, max_percent numeric,
                 category_id uuid, area_id uuid, area_name text, areas_count int, offer_label text)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_q text := private.norm(left(coalesce(p_q, ''), 60));
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 20);
begin
  if length(v_q) = 0 then return; end if;
  return query
    select p.id, p.name, p.image_path, p.discount_percent, p.max_percent, p.category_id, p.area_id,
           coalesce(case when p_area is not null then (select a2.name from public.areas a2 where a2.id = p_area) end, a.name),
           cardinality(p.area_ids), p.offer_label
    from public.providers p
    left join public.categories c on c.id = p.category_id and c.is_active
    left join public.areas a on a.id = p.area_id
    where p.is_active
      and (p_category is null or p.category_id = p_category)
      and (p_area is null or p_area = any (p.area_ids))
      and (p_min_discount is null or p.max_percent >= p_min_discount)
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
    'version', 15,
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
    'm015', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'discount_rules' and column_name = 'value_type'))
$$;
