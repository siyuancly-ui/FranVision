-- ===========================================================================
-- FranVision Job Generator -- shared job backend (Supabase)
-- ===========================================================================
-- Run ONCE in the Supabase SQL editor of the SAME project the Feature Sheet
-- Builder / photo-sync-worker use (papaswihicvajzcubbri). Re-running is safe.
--
-- Why: Job Generator runs on more than one machine (Mac + Franky's Windows)
-- with no shared filesystem, so each computed its own Job ID from local
-- folders and they collided (2026-09-15). This makes the SERVER the one
-- authority for (1) Job ID assignment and (2) job/draft metadata, so a
-- draft saved on one machine shows up on the other.
--
-- Access model: RLS is ON and there are NO table policies, so the public
-- anon key can read/write nothing directly. The only way in is the
-- SECURITY DEFINER functions below, and every one of them requires a
-- secret token (stored hashed in jg_tokens, one row per machine so a lost
-- machine's token can be deleted on its own). Local tool config:
-- JG_SUPABASE_URL / JG_SUPABASE_ANON_KEY / JG_TOKEN in job-generator/.env.
--
-- After running this file, register each machine's token (replace the
-- quoted values; keep the raw token secret, only its hash is stored):
--   insert into public.jg_tokens (label, token_hash)
--   values ('mac', encode(extensions.digest('<RAW TOKEN>', 'sha256'), 'hex'));
-- ===========================================================================

create table if not exists public.jg_tokens (
  label      text primary key,
  token_hash text not null,
  created_at timestamptz not null default now()
);
alter table public.jg_tokens enable row level security;

-- One row per job OR draft. Natural key = folder_name (Shoot Date + Address +
-- Client Name, sanitize.js#buildJobFolderName). job_id is NULL for a draft.
create table if not exists public.jg_jobs (
  id          uuid primary key default gen_random_uuid(),
  folder_name text not null unique,
  job_id      text,
  client_name text not null default '',
  address     text not null default '',
  shoot_date  text not null default '',
  data        jsonb not null default '{}'::jsonb,   -- { job: <job.json>, form: <form state> }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists jg_jobs_job_id_key on public.jg_jobs (job_id) where job_id is not null;
create index if not exists jg_jobs_created_at_idx on public.jg_jobs (created_at desc);
alter table public.jg_jobs enable row level security;

-- Per-day Job ID sequence.
create table if not exists public.jg_job_counters (
  day text primary key,          -- 'YYYYMMDD'
  seq integer not null
);
alter table public.jg_job_counters enable row level security;

revoke all on public.jg_tokens, public.jg_jobs, public.jg_job_counters from anon, authenticated;

-- Token check (internal -- not granted to anon).
create or replace function public.jg_check_token(p_token text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_token is null or not exists (
    select 1 from public.jg_tokens where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  ) then
    raise exception 'jg: invalid token' using errcode = '28000';
  end if;
end $$;
revoke all on function public.jg_check_token(text) from public, anon, authenticated;

-- Next Job ID WITHOUT reserving it (form preview only).
-- p_floor = highest sequence the caller already knows is taken today
-- (local folders / Dropbox) -- lets the counter jump past legacy jobs that
-- were never imported here.
create or replace function public.jg_peek_job_id(p_token text, p_day text, p_floor integer default 0)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare s integer;
begin
  perform public.jg_check_token(p_token);
  select greatest(coalesce((select seq from public.jg_job_counters where day = p_day), 0), coalesce(p_floor, 0)) + 1 into s;
  return 'FVS-' || p_day || '-' || lpad(s::text, 3, '0');
end $$;

-- Atomically reserve the next Job ID for a day (never hands out the same one twice).
create or replace function public.jg_allocate_job_id(p_token text, p_day text, p_floor integer default 0)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare s integer;
begin
  perform public.jg_check_token(p_token);
  insert into public.jg_job_counters (day, seq) values (p_day, greatest(coalesce(p_floor, 0), 0) + 1)
  on conflict (day) do update set seq = greatest(public.jg_job_counters.seq, coalesce(p_floor, 0)) + 1
  returning seq into s;
  return 'FVS-' || p_day || '-' || lpad(s::text, 3, '0');
end $$;

-- Create/update one job or draft. p_row: { folder_name, previous_folder_name?,
-- job_id?, client_name, address, shoot_date, created_at?, data }.
--  * previous_folder_name (differs from folder_name) => the identity was
--    renamed in place ("unlock identity fields"): that row is renamed, not
--    duplicated. Refused if the new name already belongs to another row.
--  * job_id is write-once: a real ID already on the row is never replaced or
--    cleared (a job can't go back to being a draft, or change ID).
create or replace function public.jg_upsert_job(p_token text, p_row jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_name text := p_row->>'folder_name';
  v_prev text := nullif(p_row->>'previous_folder_name', '');
  v_row  public.jg_jobs;
begin
  perform public.jg_check_token(p_token);
  if v_name is null or v_name = '' then raise exception 'jg: folder_name required'; end if;

  if v_prev is not null and v_prev <> v_name then
    if exists (select 1 from public.jg_jobs where folder_name = v_name) then
      raise exception 'jg: folder_exists' using errcode = '23505';
    end if;
    update public.jg_jobs set folder_name = v_name where folder_name = v_prev;
  end if;

  insert into public.jg_jobs (folder_name, job_id, client_name, address, shoot_date, data, created_at)
  values (v_name, nullif(p_row->>'job_id', ''), coalesce(p_row->>'client_name', ''), coalesce(p_row->>'address', ''),
          coalesce(p_row->>'shoot_date', ''), coalesce(p_row->'data', '{}'::jsonb),
          coalesce((p_row->>'created_at')::timestamptz, now()))
  on conflict (folder_name) do update set
    job_id      = coalesce(public.jg_jobs.job_id, excluded.job_id),
    client_name = excluded.client_name,
    address     = excluded.address,
    shoot_date  = excluded.shoot_date,
    data        = excluded.data,
    updated_at  = now()
  returning * into v_row;

  return to_jsonb(v_row);
end $$;

create or replace function public.jg_get_job(p_token text, p_folder_name text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_row public.jg_jobs;
begin
  perform public.jg_check_token(p_token);
  select * into v_row from public.jg_jobs where folder_name = p_folder_name;
  if not found then return null; end if;
  return to_jsonb(v_row);
end $$;

-- p_kind: 'drafts' (job_id is null, newest-updated first) or
-- 'recent' (real job_id, not yet marked Complete, newest-created first).
-- p_since is UNUSED as of 2026-09-22 (kept in the signature so this stays a
-- CREATE OR REPLACE, not a breaking drop+recreate) -- 'recent' used to mean
-- "created in the last p_since/3-days window"; it now means "not completed",
-- with NO time limit, so a job stays listed indefinitely until the user
-- clicks Complete in the UI (see jg_complete_job below).
create or replace function public.jg_list_jobs(p_token text, p_kind text, p_since timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.jg_check_token(p_token);
  if p_kind = 'drafts' then
    return coalesce((select jsonb_agg(to_jsonb(j) order by j.updated_at desc) from public.jg_jobs j where j.job_id is null), '[]'::jsonb);
  elsif p_kind = 'recent' then
    return coalesce((select jsonb_agg(to_jsonb(j) order by j.created_at desc) from public.jg_jobs j
                     where j.job_id is not null and coalesce(j.data->'job'->>'completedAt', '') = ''), '[]'::jsonb);
  end if;
  raise exception 'jg: unknown kind %', p_kind;
end $$;

-- Deletes a DRAFT only -- never a real job.
create or replace function public.jg_delete_draft(p_token text, p_folder_name text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_id text; v_found boolean;
begin
  perform public.jg_check_token(p_token);
  select job_id, true into v_id, v_found from public.jg_jobs where folder_name = p_folder_name;
  if not coalesce(v_found, false) then return jsonb_build_object('deleted', false, 'reason', 'not_found'); end if;
  if v_id is not null then return jsonb_build_object('deleted', false, 'reason', 'real_job', 'job_id', v_id); end if;
  delete from public.jg_jobs where folder_name = p_folder_name;
  return jsonb_build_object('deleted', true);
end $$;

-- Marks a real job Complete (atomic jsonb_set, no read-modify-write race) --
-- it drops out of every machine's Recent Jobs list (jg_list_jobs 'recent'
-- above). Never touches a Draft or a job with no row (2026-09-22, see
-- job-generator/job-list.js's markJobCompleted for the LOCAL half of this).
create or replace function public.jg_complete_job(p_token text, p_folder_name text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_row public.jg_jobs; v_completed_at text;
begin
  perform public.jg_check_token(p_token);
  -- Match JS's `new Date().toISOString()` format exactly (UTC, 3-digit ms, trailing Z) -- the LOCAL
  -- half of this feature (job-list.js#markJobCompleted) writes that format, and job-sync.js just
  -- passes completedAt through as an opaque string, so the two sides should look identical rather
  -- than one being Postgres's native "2026-09-22 22:25:11.517-04" text.
  v_completed_at := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  update public.jg_jobs
  set data = jsonb_set(
        coalesce(data, '{}'::jsonb), '{job}',
        coalesce(data->'job', '{}'::jsonb) || jsonb_build_object('completedAt', to_jsonb(v_completed_at))
      ),
      updated_at = now()
  where folder_name = p_folder_name and job_id is not null
  returning * into v_row;
  if not found then raise exception 'jg: job not found or not a real job'; end if;
  return to_jsonb(v_row);
end $$;

revoke all on function public.jg_peek_job_id(text, text, integer), public.jg_allocate_job_id(text, text, integer),
  public.jg_upsert_job(text, jsonb), public.jg_get_job(text, text), public.jg_list_jobs(text, text, timestamptz),
  public.jg_delete_draft(text, text), public.jg_complete_job(text, text) from public;
grant execute on function public.jg_peek_job_id(text, text, integer), public.jg_allocate_job_id(text, text, integer),
  public.jg_upsert_job(text, jsonb), public.jg_get_job(text, text), public.jg_list_jobs(text, text, timestamptz),
  public.jg_delete_draft(text, text), public.jg_complete_job(text, text) to anon;

-- ---------------------------------------------------------------------------
-- Wave customer pairing history (2026-09-23)
-- Remembers which Wave customer a job's "Client Name" ended up billed to, so the next job for the same
-- client name gets that customer suggested (never auto-selected -- Franky confirms with one click). One row
-- per (normalized client name, Wave customer); use_count grows every time that pairing is used on a
-- Create/Update Job. Shared across machines like jg_jobs (same token-gated RPC access, no table policies).
create table if not exists public.jg_wave_pairings (
  client_key          text        not null,   -- lower-cased, whitespace-collapsed Client Name
  wave_customer_id    text        not null,
  client_name         text        not null,   -- last-seen display spelling
  wave_customer_name  text        not null,
  use_count           integer     not null default 1,
  last_used_at        timestamptz not null default now(),
  primary key (client_key, wave_customer_id)
);
alter table public.jg_wave_pairings enable row level security;
revoke all on public.jg_wave_pairings from anon, authenticated;

create or replace function public.jg_norm_client_name(p text) returns text
language sql immutable as $$ select lower(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g')) $$;

create or replace function public.jg_record_wave_pairing(p_token text, p_client_name text, p_wave_customer_id text, p_wave_customer_name text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_key text := public.jg_norm_client_name(p_client_name); v_row public.jg_wave_pairings;
begin
  perform public.jg_check_token(p_token);
  if v_key = '' or coalesce(p_wave_customer_id, '') = '' then raise exception 'jg: client name and wave customer id required'; end if;
  insert into public.jg_wave_pairings (client_key, wave_customer_id, client_name, wave_customer_name)
  values (v_key, p_wave_customer_id, btrim(p_client_name), coalesce(p_wave_customer_name, ''))
  on conflict (client_key, wave_customer_id) do update set
    use_count = public.jg_wave_pairings.use_count + 1,
    client_name = excluded.client_name,
    wave_customer_name = excluded.wave_customer_name,
    last_used_at = now()
  returning * into v_row;
  return to_jsonb(v_row);
end $$;

-- Exact (normalized) name matches first, then looser "one contains the other" matches (only for names of
-- 3+ characters, to avoid junk hits on short strings); each group most-used then most-recent first.
create or replace function public.jg_suggest_wave_pairings(p_token text, p_client_name text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_key text := public.jg_norm_client_name(p_client_name);
begin
  perform public.jg_check_token(p_token);
  if length(v_key) < 2 then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'waveCustomerId', id, 'waveCustomerName', cname, 'clientName', client_name,
             'useCount', use_count, 'lastUsedAt', last_used_at, 'match', kind) order by rank, use_count desc, last_used_at desc)
    from (
      select wave_customer_id as id, wave_customer_name as cname, client_name, use_count, last_used_at,
             case when client_key = v_key then 'exact' else 'partial' end as kind,
             case when client_key = v_key then 0 else 1 end as rank
      from public.jg_wave_pairings
      where client_key = v_key
         or (length(v_key) >= 3 and length(client_key) >= 3 and (client_key like '%' || v_key || '%' or v_key like '%' || client_key || '%'))
      order by rank, use_count desc, last_used_at desc
      limit 5
    ) s
  ), '[]'::jsonb);
end $$;

-- One-time backfill from jobs already carrying a picked Wave customer (only when the table is still empty,
-- so re-running this file never double-counts).
insert into public.jg_wave_pairings (client_key, wave_customer_id, client_name, wave_customer_name, use_count, last_used_at)
select public.jg_norm_client_name(client_name), data->'job'->>'waveCustomerId', max(client_name),
       coalesce(max(data->'job'->>'waveCustomerName'), ''), count(*), max(updated_at)
from public.jg_jobs
where coalesce(data->'job'->>'waveCustomerId', '') <> '' and public.jg_norm_client_name(client_name) <> ''
  and not exists (select 1 from public.jg_wave_pairings)
group by 1, 2;

revoke all on function public.jg_record_wave_pairing(text, text, text, text), public.jg_suggest_wave_pairings(text, text) from public;
grant execute on function public.jg_record_wave_pairing(text, text, text, text), public.jg_suggest_wave_pairings(text, text) to anon;
