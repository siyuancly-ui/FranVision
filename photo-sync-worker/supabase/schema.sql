-- ===========================================================================
-- FranVision Photo Sync Worker -- Supabase schema
-- ===========================================================================
-- Run ONCE in the Supabase SQL editor of the SAME project the Feature Sheet
-- Builder uses (papaswihicvajzcubbri). Re-running is safe (idempotent).
--
-- This adds, on top of the Feature Sheet Builder's existing `projects` table
-- and `photos` storage bucket:
--   1. photo_sync_state  -- the Dropbox delta cursor + a lease lock
--   2. photos_upsert()   -- atomic add/update of one photo in projects.data.photos
--   3. photos_mark_pending() -- flag one photo pending_review (Dropbox-side delete)
--
-- Nothing here is exposed to the `anon` role. Only the Worker, using the
-- service-role key, calls these.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Worker state: one row, id = 'default'
-- ---------------------------------------------------------------------------
create table if not exists public.photo_sync_state (
  id           text primary key default 'default',
  cursor       text,                       -- Dropbox list_folder cursor (recursive, from DROPBOX_JOBS_ROOT)
  locked_until timestamptz,                -- lease lock: a delta run holds this while advancing the cursor
  last_run_at  timestamptz,
  stats        jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now()
);

alter table public.photo_sync_state enable row level security;
-- No policies => anon/authenticated get nothing. service_role bypasses RLS.

insert into public.photo_sync_state (id) values ('default')
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. photos_upsert -- atomically merge one photo into projects.data.photos[]
-- ---------------------------------------------------------------------------
-- - Creates the projects row (data = {"photos": []}) if it does not exist.
-- - Locks the row (FOR UPDATE) so concurrent calls for the same project --
--   the Worker processing several batches at once, or the Feature Sheet
--   Builder saving at the same time -- serialize instead of clobbering.
-- - Matches an existing entry by photoId. If found, shallow-merges
--   (existing || p_photo): the Worker's keys win, every other key the
--   Feature Sheet Builder owns (role, sortOrder, ...) is preserved. If not
--   found, appends.
-- - Self-heal: the caller passes status:'ok' on a normal sync, so an entry
--   that was 'pending_review' flips back to 'ok' automatically via the merge.
create or replace function public.photos_upsert(p_project_id text, p_photo jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_photos   jsonb;
  v_existing jsonb;
  v_idx      int;
  v_healed   boolean := false;
  v_merged   jsonb;
begin
  if p_photo->>'photoId' is null then
    raise exception 'photos_upsert: p_photo.photoId is required';
  end if;

  insert into public.projects (id, data)
    values (p_project_id, jsonb_build_object('photos', '[]'::jsonb))
    on conflict (id) do nothing;

  -- serialize concurrent writers to this project
  perform 1 from public.projects where id = p_project_id for update;

  select coalesce(data->'photos', '[]'::jsonb) into v_photos
    from public.projects where id = p_project_id;

  select elem, (ord - 1)
    into v_existing, v_idx
    from jsonb_array_elements(v_photos) with ordinality as t(elem, ord)
   where elem->>'photoId' = p_photo->>'photoId'
   limit 1;

  if v_existing is null then
    update public.projects
       set data = jsonb_set(
             coalesce(data, '{}'::jsonb),
             '{photos}',
             v_photos || p_photo
           ),
           updated_at = now()
     where id = p_project_id;
  else
    v_healed := (v_existing->>'status' = 'pending_review')
                and (p_photo->>'status' = 'ok');
    v_merged := v_existing || p_photo;
    update public.projects
       set data = jsonb_set(data, array['photos', v_idx::text], v_merged),
           updated_at = now()
     where id = p_project_id;
  end if;

  return jsonb_build_object(
    'photoId', p_photo->>'photoId',
    'created', (v_existing is null),
    'healed', v_healed
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. photos_mark_pending -- Dropbox-side delete: flag, do not remove
-- ---------------------------------------------------------------------------
create or replace function public.photos_mark_pending(p_project_id text, p_photo_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_idx int;
begin
  perform 1 from public.projects where id = p_project_id for update;

  select (ord - 1) into v_idx
    from public.projects p,
         jsonb_array_elements(coalesce(p.data->'photos', '[]'::jsonb)) with ordinality as t(elem, ord)
   where p.id = p_project_id
     and elem->>'photoId' = p_photo_id
   limit 1;

  if v_idx is null then
    return jsonb_build_object('photoId', p_photo_id, 'found', false);
  end if;

  update public.projects
     set data = jsonb_set(data, array['photos', v_idx::text, 'status'], '"pending_review"'::jsonb),
         updated_at = now()
   where id = p_project_id;

  return jsonb_build_object('photoId', p_photo_id, 'found', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants -- service_role only (it bypasses RLS; these make intent explicit).
-- ---------------------------------------------------------------------------
revoke all on function public.photos_upsert(text, jsonb)      from public, anon, authenticated;
revoke all on function public.photos_mark_pending(text, text) from public, anon, authenticated;
grant execute on function public.photos_upsert(text, jsonb)      to service_role;
grant execute on function public.photos_mark_pending(text, text) to service_role;

-- ===========================================================================
-- Video sync (Dropbox -> Cloudflare Stream -> projects.data.videos[])
-- ===========================================================================
-- Mirrors the photo objects above exactly, just targeting `videos` / `videoId`
-- instead of `photos` / `photoId`, plus one extra table: Stream encodes
-- asynchronously, so `video_sync_pending` tracks in-flight uploads for the
-- 2-min cron to poll until Stream reports readyToStream (or error).

-- ---------------------------------------------------------------------------
-- 4. video_sync_pending -- one row per video awaiting Stream encoding
-- ---------------------------------------------------------------------------
create table if not exists public.video_sync_pending (
  id          bigserial primary key,
  project_id  text not null,
  video_id    text not null,
  stream_uid  text not null,
  created_at  timestamptz not null default now(),
  unique (project_id, video_id)
);

alter table public.video_sync_pending enable row level security;
-- No policies => anon/authenticated get nothing. service_role bypasses RLS.

-- ---------------------------------------------------------------------------
-- 5. videos_upsert -- atomically merge one video into projects.data.videos[]
-- ---------------------------------------------------------------------------
-- Same shape/semantics as photos_upsert: creates the projects row if missing,
-- locks it (FOR UPDATE), matches by videoId, shallow-merges so a later partial
-- update (e.g. the poll step adding playbackUrl once ready) doesn't clobber
-- fields written by the initial "processing" upsert.
create or replace function public.videos_upsert(p_project_id text, p_video jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_videos   jsonb;
  v_existing jsonb;
  v_idx      int;
  v_merged   jsonb;
begin
  if p_video->>'videoId' is null then
    raise exception 'videos_upsert: p_video.videoId is required';
  end if;

  insert into public.projects (id, data)
    values (p_project_id, jsonb_build_object('videos', '[]'::jsonb))
    on conflict (id) do nothing;

  perform 1 from public.projects where id = p_project_id for update;

  select coalesce(data->'videos', '[]'::jsonb) into v_videos
    from public.projects where id = p_project_id;

  select elem, (ord - 1)
    into v_existing, v_idx
    from jsonb_array_elements(v_videos) with ordinality as t(elem, ord)
   where elem->>'videoId' = p_video->>'videoId'
   limit 1;

  if v_existing is null then
    update public.projects
       set data = jsonb_set(
             coalesce(data, '{}'::jsonb),
             '{videos}',
             v_videos || p_video
           ),
           updated_at = now()
     where id = p_project_id;
  else
    v_merged := v_existing || p_video;
    update public.projects
       set data = jsonb_set(data, array['videos', v_idx::text], v_merged),
           updated_at = now()
     where id = p_project_id;
  end if;

  return jsonb_build_object('videoId', p_video->>'videoId', 'created', (v_existing is null));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. videos_mark_pending -- Dropbox-side delete: flag, do not remove
-- ---------------------------------------------------------------------------
create or replace function public.videos_mark_pending(p_project_id text, p_video_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_idx int;
begin
  perform 1 from public.projects where id = p_project_id for update;

  select (ord - 1) into v_idx
    from public.projects p,
         jsonb_array_elements(coalesce(p.data->'videos', '[]'::jsonb)) with ordinality as t(elem, ord)
   where p.id = p_project_id
     and elem->>'videoId' = p_video_id
   limit 1;

  if v_idx is null then
    return jsonb_build_object('videoId', p_video_id, 'found', false);
  end if;

  update public.projects
     set data = jsonb_set(data, array['videos', v_idx::text, 'status'], '"pending_review"'::jsonb),
         updated_at = now()
   where id = p_project_id;

  return jsonb_build_object('videoId', p_video_id, 'found', true);
end;
$$;

revoke all on function public.videos_upsert(text, jsonb)      from public, anon, authenticated;
revoke all on function public.videos_mark_pending(text, text) from public, anon, authenticated;
grant execute on function public.videos_upsert(text, jsonb)      to service_role;
grant execute on function public.videos_mark_pending(text, text) to service_role;
