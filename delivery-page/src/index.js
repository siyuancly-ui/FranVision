import { createSupabase } from './supabase.js';
import { buildDeliveryModel, renderDeliveryPage, renderNotFoundPage } from './render.js';

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function folderList(env, key) {
  return String(env[key] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function handleDelivery(jobId, env) {
  const sb = createSupabase(env);
  const project = await sb.getProject(jobId);
  if (!project) return html(renderNotFoundPage(jobId), 404);

  const model = buildDeliveryModel(project, {
    jobId,
    supabaseUrl: String(env.SUPABASE_URL || '').replace(/\/+$/, ''),
    galleryFolders: folderList(env, 'GALLERY_FOLDERS'),
    localReportFolder: env.LOCAL_REPORT_FOLDER || 'Local Report',
    videoFolders: folderList(env, 'VIDEO_FOLDERS'),
    coverPhotoFolder: env.COVER_PHOTO_FOLDER || 'Cover',
    closingPhotoFolder: env.CLOSING_PHOTO_FOLDER || 'Closing',
    droneCalloutFolder: env.DRONE_CALLOUT_FOLDER || 'Callout',
  });
  return html(renderDeliveryPage(model));
}

async function handleAdminSetJob(jobId, request, env) {
  const auth = request.headers.get('authorization') || '';
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'unauthorized' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const fields = {};
  if (typeof body.address === 'string' || body.address === null) fields.address = typeof body.address === 'string' ? body.address.trim() : null;
  if (typeof body.tourUrl === 'string' || body.tourUrl === null) fields.tourUrl = typeof body.tourUrl === 'string' ? body.tourUrl.trim() : null;
  if (body.tourType === 'floor_tour' || body.tourType === '3d_tour' || body.tourType === null) fields.tourType = body.tourType;

  if (Object.keys(fields).length === 0) return json({ error: 'no recognized fields (address, tourUrl, tourType)' }, 400);

  const sb = createSupabase(env);
  const result = await sb.setDeliveryInfo(jobId, fields);
  return json({ jobId, fields, result });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (request.method === 'GET' && parts.length === 0) {
      return new Response('franvision-delivery-page: ok', { headers: { 'content-type': 'text/plain' } });
    }

    if (request.method === 'GET' && parts[0] === 'delivery' && parts[1]) {
      try {
        return await handleDelivery(decodeURIComponent(parts[1]), env);
      } catch (err) {
        console.log('delivery_render_error', { jobId: parts[1], error: String(err) });
        return html(renderNotFoundPage(parts[1]), 500);
      }
    }

    if (request.method === 'POST' && parts[0] === 'admin' && parts[1] === 'jobs' && parts[2]) {
      try {
        return await handleAdminSetJob(decodeURIComponent(parts[2]), request, env);
      } catch (err) {
        console.log('admin_set_job_error', { jobId: parts[2], error: String(err) });
        return json({ error: String(err) }, 500);
      }
    }

    return new Response('not found', { status: 404 });
  },
};
