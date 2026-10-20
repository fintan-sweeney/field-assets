-- =====================================================================
-- Field Assets - database schema for Supabase (PostgreSQL + PostGIS)
--
-- Run this once in the Supabase dashboard: SQL Editor > New query >
-- paste this whole file > Run. It is safe to run again (idempotent).
-- =====================================================================

create extension if not exists postgis with schema extensions;
set search_path = public, extensions;

-- ---------------------------------------------------------------------
-- 1. People allowed to use the app
--    A row is created automatically when you invite someone from
--    Authentication > Users. Edit role / active / access_expires in the
--    Table Editor to manage access (e.g. contractor end dates).
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  email          text,
  full_name      text,
  company        text,
  role           text not null default 'staff'
                   check (role in ('admin', 'staff', 'contractor')),
  active         boolean not null default true,
  access_expires date,                       -- null = no expiry
  created_at     timestamptz not null default now()
);

comment on column public.profiles.access_expires is
  'Last day this person can use the app (inclusive). Use for contractors.';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for anyone invited before this script was run
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- Is the signed-in user currently allowed to use the app?
create or replace function public.is_authorised()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.active
      and (p.access_expires is null or p.access_expires >= current_date)
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active and p.role = 'admin'
  );
$$;

-- ---------------------------------------------------------------------
-- 2. Assets (a read-only copy of your ArcGIS layers, refreshed daily)
-- ---------------------------------------------------------------------
create table if not exists public.assets (
  layer          text not null,              -- e.g. 'Poles', 'Pits'
  asset_id       text not null,              -- your asset ID from ArcGIS
  name           text,
  asset_type     text,
  status         text,
  attributes     jsonb not null default '{}'::jsonb,  -- extra fields to show
  geom           geometry(Geometry, 4326) not null,
  last_sync_run  uuid,
  synced_at      timestamptz not null default now(),
  primary key (layer, asset_id)
);

create index if not exists assets_geom_idx on public.assets using gist (geom);
create index if not exists assets_sync_idx on public.assets (layer, last_sync_run);

-- History of sync runs, so you can see the sync is working
create table if not exists public.sync_runs (
  id            uuid primary key,
  layer         text not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  features_seen integer,
  deleted       integer,
  status        text not null default 'running'   -- running | ok | failed
);

-- ---------------------------------------------------------------------
-- 3. Location log
-- ---------------------------------------------------------------------
create table if not exists public.location_log (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  recorded_at  timestamptz not null,          -- time on the phone
  received_at  timestamptz not null default now(),
  geom         geography(Point, 4326) not null,
  accuracy_m   real,
  speed_mps    real,
  heading_deg  real,
  source       text                          -- 'track' | 'manual'
);

create index if not exists location_log_user_time_idx on public.location_log (user_id, recorded_at desc);
create index if not exists location_log_geom_idx on public.location_log using gist (geom);

-- Convenient view for admins / exporting to ArcGIS (CSV or ogr2ogr)
create or replace view public.location_log_view
with (security_invoker = true) as
select l.id,
       p.email,
       p.full_name,
       p.company,
       l.recorded_at,
       st_y(l.geom::geometry) as latitude,
       st_x(l.geom::geometry) as longitude,
       l.accuracy_m,
       l.source,
       l.geom
from public.location_log l
join public.profiles p on p.id = l.user_id;

-- ---------------------------------------------------------------------
-- 4. Row Level Security - who can see / change what
-- ---------------------------------------------------------------------
alter table public.profiles     enable row level security;
alter table public.assets       enable row level security;
alter table public.sync_runs    enable row level security;
alter table public.location_log enable row level security;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "authorised users read assets" on public.assets;
create policy "authorised users read assets" on public.assets
  for select to authenticated
  using ((select public.is_authorised()));

drop policy if exists "admins read sync runs" on public.sync_runs;
create policy "admins read sync runs" on public.sync_runs
  for select to authenticated
  using ((select public.is_admin()));

drop policy if exists "log own location" on public.location_log;
create policy "log own location" on public.location_log
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_authorised()));

drop policy if exists "read own locations" on public.location_log;
create policy "read own locations" on public.location_log
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- Nobody (not even the app) can edit or delete assets or logs directly.
-- The sync script writes assets through the service-only functions below.
revoke insert, update, delete on public.assets from anon, authenticated;
revoke update, delete on public.location_log from anon, authenticated;
revoke insert, update, delete on public.profiles from anon, authenticated;
revoke all on public.sync_runs from anon;
revoke all on public.location_log_view from anon;

-- ---------------------------------------------------------------------
-- 5. Functions the app calls
-- ---------------------------------------------------------------------

-- Nearest assets to a point. Lines and polygons are measured to their
-- closest edge; lat/lon returned is that closest point (for directions).
create or replace function public.nearest_assets(
  p_lat            double precision,
  p_lon            double precision,
  p_limit          integer default 30,
  p_max_distance_m double precision default 5000
)
returns table (
  layer       text,
  asset_id    text,
  name        text,
  asset_type  text,
  status      text,
  attributes  jsonb,
  distance_m  double precision,
  lat         double precision,
  lon         double precision
)
language sql
stable
security invoker          -- row level security applies
set search_path = public, extensions
as $$
  with pt as (
    select st_setsrid(st_makepoint(p_lon, p_lat), 4326) as g
  ),
  candidates as (            -- fast index-based pre-selection
    select a.*
    from public.assets a
    order by a.geom <-> st_setsrid(st_makepoint(p_lon, p_lat), 4326)
    limit greatest(least(coalesce(p_limit, 30), 200) * 5, 100)
  ),
  measured as (              -- accurate distance in metres
    select c.*,
           st_distance(c.geom::geography, pt.g::geography) as d,
           st_closestpoint(c.geom, pt.g) as cp
    from candidates c, pt
  )
  select m.layer, m.asset_id, m.name, m.asset_type, m.status, m.attributes,
         round(m.d::numeric, 1)::double precision,
         st_y(m.cp), st_x(m.cp)
  from measured m
  where m.d <= coalesce(p_max_distance_m, 5000)
  order by m.d
  limit least(coalesce(p_limit, 30), 200);
$$;

-- Save one or more location fixes (the app sends queued fixes in batches)
-- p_points: [{"lat":..,"lon":..,"accuracy":..,"speed":..,"heading":..,
--             "recorded_at":"2026-10-20T01:00:00Z","source":"track"}]
create or replace function public.log_locations(p_points jsonb)
returns integer
language plpgsql
security invoker          -- row level security applies
set search_path = public, extensions
as $$
declare
  n integer;
begin
  if jsonb_typeof(p_points) <> 'array' or jsonb_array_length(p_points) > 500 then
    raise exception 'p_points must be an array of at most 500 points';
  end if;

  insert into public.location_log
    (user_id, recorded_at, geom, accuracy_m, speed_mps, heading_deg, source)
  select auth.uid(),
         least(coalesce((p->>'recorded_at')::timestamptz, now()), now()),
         st_setsrid(st_makepoint((p->>'lon')::float8, (p->>'lat')::float8), 4326)::geography,
         (p->>'accuracy')::real,
         (p->>'speed')::real,
         (p->>'heading')::real,
         coalesce(p->>'source', 'track')
  from jsonb_array_elements(p_points) p
  where (p->>'lat')::float8 between -90 and 90
    and (p->>'lon')::float8 between -180 and 180;

  get diagnostics n = row_count;
  return n;
end;
$$;

-- Who am I? (lets the app show a clear message if access has expired)
create or replace function public.my_access()
returns table (email text, full_name text, role text, authorised boolean, access_expires date)
language sql
stable
security definer
set search_path = public
as $$
  select p.email, p.full_name, p.role, public.is_authorised(), p.access_expires
  from public.profiles p
  where p.id = auth.uid();
$$;

-- ---------------------------------------------------------------------
-- 6. Functions only the sync script can call (service / secret key)
-- ---------------------------------------------------------------------

-- Insert or update a batch of assets.
-- p_features: [{"asset_id":"..","name":"..","asset_type":"..","status":"..",
--               "attributes":{..},"geometry":{GeoJSON geometry}}]
create or replace function public.sync_upsert_assets(
  p_layer    text,
  p_run      uuid,
  p_features jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  n integer;
begin
  insert into public.sync_runs (id, layer) values (p_run, p_layer)
  on conflict (id) do nothing;

  insert into public.assets as a
    (layer, asset_id, name, asset_type, status, attributes, geom, last_sync_run, synced_at)
  select p_layer,
         f->>'asset_id',
         f->>'name',
         f->>'asset_type',
         f->>'status',
         coalesce(f->'attributes', '{}'::jsonb),
         st_setsrid(st_force2d(st_geomfromgeojson(f->>'geometry')), 4326),
         p_run,
         now()
  from jsonb_array_elements(p_features) f
  where f->>'asset_id' is not null
    and f->'geometry' is not null
    and jsonb_typeof(f->'geometry') = 'object'
  on conflict (layer, asset_id) do update
    set name          = excluded.name,
        asset_type    = excluded.asset_type,
        status        = excluded.status,
        attributes    = excluded.attributes,
        geom          = excluded.geom,
        last_sync_run = excluded.last_sync_run,
        synced_at     = excluded.synced_at;

  get diagnostics n = row_count;
  return n;
end;
$$;

-- Finish a sync run: remove assets that no longer exist in ArcGIS.
-- Safety check: refuses to delete if this run saw far fewer assets than
-- are currently stored (e.g. ArcGIS returned a partial result), unless
-- p_force is true.
create or replace function public.sync_finish(
  p_layer text,
  p_run   uuid,
  p_seen  integer,
  p_force boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  existing integer;
  removed  integer := 0;
begin
  select count(*) into existing from public.assets where layer = p_layer;

  if not p_force and existing > 0 and p_seen < existing * 0.5 then
    raise exception 'Safety stop: run saw % features but % are stored for layer %. Re-run with --force if this is expected.',
      p_seen, existing, p_layer;
  end if;

  delete from public.assets
  where layer = p_layer
    and last_sync_run is distinct from p_run;
  get diagnostics removed = row_count;

  insert into public.sync_runs (id, layer, finished_at, features_seen, deleted, status)
  values (p_run, p_layer, now(), p_seen, removed, 'ok')
  on conflict (id) do update
    set finished_at = now(), features_seen = p_seen, deleted = removed, status = 'ok';

  return removed;
end;
$$;

-- Lock down function permissions
revoke all on function public.sync_upsert_assets(text, uuid, jsonb)      from public, anon, authenticated;
revoke all on function public.sync_finish(text, uuid, integer, boolean)  from public, anon, authenticated;
grant execute on function public.sync_upsert_assets(text, uuid, jsonb)     to service_role;
grant execute on function public.sync_finish(text, uuid, integer, boolean) to service_role;

revoke all on function public.nearest_assets(double precision, double precision, integer, double precision) from public, anon;
revoke all on function public.log_locations(jsonb) from public, anon;
revoke all on function public.my_access() from public, anon;
grant execute on function public.nearest_assets(double precision, double precision, integer, double precision) to authenticated;
grant execute on function public.log_locations(jsonb) to authenticated;
grant execute on function public.my_access() to authenticated;

-- Optional: delete location history older than 2 years. Adjust to suit
-- your retention policy, and schedule with Supabase Cron (pg_cron) if wanted:
--   delete from public.location_log where recorded_at < now() - interval '2 years';
