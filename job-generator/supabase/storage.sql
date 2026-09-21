-- FranVision Job Generator -- shoot-notes image storage (stage 2, 2026-09-21).
--
-- Save as Draft uploads the shoot-notes screenshots here and puts the LINKS
-- in the calendar event's DESCRIPTION (instead of base64 ATTACH, which only
-- Apple Calendar / classic Outlook showed).
--
-- Access model (same spirit as schema.sql):
--   * bucket is PUBLIC-READ: anyone holding a link can open the image, so the
--     path is a random 128-bit hex -- unguessable, and there is no listing.
--   * WRITE only for a registered machine: the INSERT policy checks the
--     `x-jg-token` request header against jg_tokens. No UPDATE/DELETE/SELECT
--     policies, so nothing can be overwritten, deleted or listed via the API.
--
-- Run once in the Supabase SQL editor (safe to re-run).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'jg-shoot-notes', 'jg-shoot-notes', true, 16 * 1024 * 1024,
  array['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif']
)
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Boolean twin of jg_check_token, callable from the storage policy (which
-- runs as `anon`). Only answers "is this a registered machine token?".
create or replace function public.jg_token_ok(p_token text) returns boolean
language sql security definer stable set search_path = public, extensions as $$
  select p_token is not null and exists (
    select 1 from public.jg_tokens where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  );
$$;
revoke all on function public.jg_token_ok(text) from public;
grant execute on function public.jg_token_ok(text) to anon;

drop policy if exists "jg machines can upload shoot-notes images" on storage.objects;
create policy "jg machines can upload shoot-notes images"
  on storage.objects for insert to anon
  with check (
    bucket_id = 'jg-shoot-notes'
    and public.jg_token_ok(current_setting('request.headers', true)::json ->> 'x-jg-token')
  );
