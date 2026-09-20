-- ===========================================================================
-- fsb_project_patch -- how the Feature Sheet Builder saves a JOB-LINKED sheet
--
-- Run once in the Supabase SQL editor (project papaswihicvajzcubbri).
--
-- Why: a job-linked sheet lives in the SAME projects row the photo-sync-worker
-- and delivery-page write to (id = jobId, e.g. FVS-20260915-001). That row's
-- `data` also holds photos[] (Dropbox-synced gallery), videos[], address,
-- tourUrl ... The FSB's old save (`update projects set data = <whole blob>`)
-- would wipe those. This function instead MERGES only what the FSB owns:
--   * the whitelisted top-level keys below (a JSON null value removes the key)
--   * the role-tagged entries of photos[] (headshot / logo) -- replaced with
--     p_assets when p_assets is not null; every other photos[] entry (the
--     worker's) is left exactly as it is.
-- One statement under a row lock, so it serializes with the worker's
-- photos_upsert() instead of racing it.
--
-- Anything else in p_patch (photos, videos, address, tourUrl, ...) is ignored.
-- ===========================================================================

create or replace function public.fsb_project_patch(
  p_id     text,
  p_patch  jsonb,
  p_assets jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed constant text[] := array[
    'templateSystem', 'colorTheme', 'topPhotoStyle', 'imageSizes', 'boxOffsets',
    'boxSizes', 'templateId', 'propertyInfo', 'agentInfo', 'agentInfo2', 'pages',
    'confirmed', 'confirmedAt', 'deletedAt'
  ];
  d   jsonb;
  k   text;
  v   jsonb;
  out jsonb;
begin
  select data into d from public.projects where id = p_id for update;
  if not found then
    raise exception 'Project not found';
  end if;
  d := coalesce(d, '{}'::jsonb);

  for k, v in select key, value from jsonb_each(coalesce(p_patch, '{}'::jsonb)) loop
    if not (k = any (allowed)) then
      continue;
    end if;
    if jsonb_typeof(v) = 'null' then
      d := d - k;
    else
      d := jsonb_set(d, array[k], v, true);
    end if;
  end loop;

  if p_assets is not null then
    d := jsonb_set(
      d, '{photos}',
      coalesce((
        select jsonb_agg(e order by ord)
          from jsonb_array_elements(coalesce(d->'photos', '[]'::jsonb)) with ordinality as t(e, ord)
         where not (e ? 'role')
      ), '[]'::jsonb)
      || coalesce((
        select jsonb_agg(a order by ord)
          from jsonb_array_elements(p_assets) with ordinality as u(a, ord)
         where a->>'role' in ('headshot', 'logo')
      ), '[]'::jsonb),
      true
    );
  end if;

  update public.projects set data = d, updated_at = now() where id = p_id;
  select to_jsonb(p) into out from public.projects p where p.id = p_id;
  return out;
end;
$$;

revoke all on function public.fsb_project_patch(text, jsonb, jsonb) from public;
grant execute on function public.fsb_project_patch(text, jsonb, jsonb) to anon, authenticated, service_role;
