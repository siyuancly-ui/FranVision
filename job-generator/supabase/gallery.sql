-- ===========================================================================
-- FranVision -- Gallery page link tokens (2026-09-24)
-- ===========================================================================
-- Run ONCE in the Supabase SQL editor of the SAME project as schema.sql
-- (papaswihicvajzcubbri), AFTER schema.sql (uses jg_check_token).
-- Re-running is safe.
--
-- The standalone Gallery page (delivery-page/src/gallery.js) sits behind
-- payment, so its URL /delivery/<address-slug>/<token> must not be guessable
-- from the sequential Job ID. The token is a random 128-bit value generated
-- HERE, once per Job, and kept in gallery_tokens:
--   * Job Generator asks for it via jg_gallery_token() with its own JG_TOKEN
--     (same access model as every other jg_* function -- no new secret on any
--     machine; deleting a machine's jg_tokens row revokes it here too);
--   * the delivery-page Worker resolves token -> job_id with its service-role
--     key (RLS is ON with no policies, so anon/authenticated read nothing).
-- Idempotent per Job: asking again (Job Update, another machine) returns the
-- SAME token, so a link already emailed keeps working. To revoke/rotate one
-- Job's link: delete its gallery_tokens row (the next Create/Update Job mints
-- a fresh one).
-- ===========================================================================

create table if not exists public.gallery_tokens (
  job_id     text primary key,
  token      text not null unique,
  created_at timestamptz not null default now()
);
alter table public.gallery_tokens enable row level security;
revoke all on public.gallery_tokens from anon, authenticated;

create or replace function public.jg_gallery_token(p_token text, p_job_id text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_token text;
begin
  perform public.jg_check_token(p_token);
  -- Only well-formed Job IDs (FVS-YYYYMMDD-NNN). Deliberately NOT required to
  -- exist in jg_jobs yet: Create Job writes the Delivery Email (which needs this
  -- token) BEFORE its final jg_upsert_job. The caller is already authenticated
  -- by its machine token, and a token for a Job with no project just 404s.
  if p_job_id is null or p_job_id !~ '^FVS-[0-9]{8}-[0-9]{3,}$' then
    raise exception 'jg: not a valid job id';
  end if;
  insert into public.gallery_tokens (job_id, token)
  values (p_job_id, encode(extensions.gen_random_bytes(16), 'hex'))
  on conflict (job_id) do nothing;
  select token into v_token from public.gallery_tokens where job_id = p_job_id;
  return v_token;
end $$;

revoke all on function public.jg_gallery_token(text, text) from public;
grant execute on function public.jg_gallery_token(text, text) to anon;
