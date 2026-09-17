-- ===========================================================================
-- FranVision Delivery Page Worker -- Supabase schema
-- ===========================================================================
-- Run ONCE in the Supabase SQL editor of the SAME project photo-sync-worker
-- uses (papaswihicvajzcubbri). Re-running is safe (idempotent).
--
-- Adds one function on top of the existing `projects` table:
--   project_set_delivery_info() -- merge {address, tourUrl, tourType} into
--   projects.data (top-level keys, alongside photos[]/videos[]).
--
-- Not exposed to `anon`. Only this Worker, using the service-role key, calls
-- it (from POST /admin/jobs/<jobId>).
-- ===========================================================================

create or replace function public.project_set_delivery_info(p_project_id text, p_fields jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.projects (id, data)
    values (p_project_id, '{}'::jsonb)
    on conflict (id) do nothing;

  perform 1 from public.projects where id = p_project_id for update;

  update public.projects
     set data = coalesce(data, '{}'::jsonb) || p_fields,
         updated_at = now()
   where id = p_project_id;

  return jsonb_build_object('projectId', p_project_id, 'fields', p_fields);
end;
$$;

revoke all on function public.project_set_delivery_info(text, jsonb) from public, anon, authenticated;
grant execute on function public.project_set_delivery_info(text, jsonb) to service_role;
