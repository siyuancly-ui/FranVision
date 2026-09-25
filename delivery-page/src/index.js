import { createSupabase } from './supabase.js';
import { buildDeliveryModel, renderDeliveryPage, renderNotFoundPage } from './render.js';
import { buildAdminModel, renderAdminPage } from './admin.js';
import {
  isHubToken, isLineKey, buildHubModel, resolveTarget, isUnlocked, remainingCents, pdfSourceUrl, renderHubPage, renderClientView, renderInvoicePage, renderNotFoundHub, renderNotReadyHub,
} from './hub.js';
import { verifyWaveSignature, classifyWaveEvent } from './wave-webhook.js';
import {
  buildGalleryModel, renderGalleryPage, renderGalleryNotFoundPage, renderGalleryPreparingPage, isGalleryToken, zipFilename, attachmentDisposition,
} from './gallery.js';

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...extraHeaders } });
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...extraHeaders } });
}

function folderList(env, key) {
  return String(env[key] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function handleDelivery(jobId, env) {
  const sb = createSupabase(env);
  const project = await sb.getProject(jobId);
  if (!project) return html(renderNotFoundPage(jobId), 404);

  const model = buildDeliveryModel(project, deliveryOpts(jobId, env));
  return html(renderDeliveryPage(model));
}

function deliveryOpts(jobId, env) {
  return {
    jobId,
    supabaseUrl: String(env.SUPABASE_URL || '').replace(/\/+$/, ''),
    galleryFolders: folderList(env, 'GALLERY_FOLDERS'),
    localReportFolder: env.LOCAL_REPORT_FOLDER || 'Local Report',
    videoFolders: folderList(env, 'VIDEO_FOLDERS'),
    coverClosingFolder: env.COVER_CLOSING_FOLDER || 'Cover&Closing',
    droneCalloutFolder: env.DRONE_CALLOUT_FOLDER || 'Callout',
    floorplanFolder: env.FLOORPLAN_FOLDER || 'Floorplan',
  };
}

// Calls photo-sync-worker (which owns the Dropbox credentials) -- over a
// service binding in production (never reachable from the internet with this
// token), or PHOTO_SYNC_URL for local `wrangler dev`.
function callPhotoSync(env, path, extra = {}) {
  const init = { ...extra, headers: { authorization: `Bearer ${env.PHOTO_SYNC_TOKEN || ''}`, ...(extra.headers || {}) } };
  if (env.PHOTO_SYNC) return env.PHOTO_SYNC.fetch(`https://photo-sync.internal${path}`, init);
  if (env.PHOTO_SYNC_URL) return fetch(`${String(env.PHOTO_SYNC_URL).replace(/\/+$/, '')}${path}`, init);
  return Promise.resolve(new Response('photo sync not configured', { status: 503 }));
}

// GET /delivery/<address-slug>/<token>[/zip/<original|mls> | /photo/<photoId>]
// parts[1] (the slug) is cosmetic and never inspected; parts[2] is the signed
// random token minted per Job (see gallery.js). A wrong token is
// indistinguishable from a missing Job (same 404 page) so the route can't be
// used to probe which Jobs exist.
async function handleGallery(parts, env) {
  const notFound = () => html(renderGalleryNotFoundPage(), 404);
  if (!isGalleryToken(parts[2])) return notFound();
  const sb = createSupabase(env);
  const jobId = await sb.getGalleryJobId(parts[2]);
  if (!jobId) return notFound();
  const [project, pendingCopies] = await Promise.all([sb.getProject(jobId), sb.listPendingCopySources(jobId)]);
  if (!project) return notFound();

  if (parts.length === 3) {
    const base = `/${parts.slice(0, 3).map(encodeURIComponent).join('/')}`;
    return html(renderGalleryPage(buildGalleryModel(project, deliveryOpts(jobId, env), pendingCopies), { base }));
  }

  if (parts.length === 5 && parts[3] === 'zip' && (parts[4] === 'original' || parts[4] === 'mls')) {
    const kind = parts[4];
    // The grid decides what is in the ZIP (see gallery.js): send exactly its
    // photo ids. Anything not ready yet -> a friendly page, never a short zip.
    const model = buildGalleryModel(project, deliveryOpts(jobId, env), pendingCopies);
    const ready = kind === 'mls' ? model.mlsReady : model.originalReady;
    const back = `/${parts.slice(0, 3).map(encodeURIComponent).join('/')}`;
    if (!ready) return html(renderGalleryPreparingPage(back), 503);
    const upstream = await callPhotoSync(env, `/zip/${encodeURIComponent(jobId)}?kind=${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ photoIds: kind === 'mls' ? model.mlsPhotoIds : model.originalPhotoIds }),
    });
    if (!upstream.ok) return html(renderGalleryPreparingPage(back), upstream.status === 409 ? 503 : 502);
    return new Response(upstream.body, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${zipFilename(project.data && project.data.address, jobId, kind)}"`,
        'cache-control': 'no-store',
      },
    });
  }

  if (parts.length === 5 && parts[3] === 'photo') {
    const upstream = await callPhotoSync(env, `/render/${encodeURIComponent(jobId)}/${encodeURIComponent(parts[4])}?size=web`);
    if (!upstream.ok) return new Response('not found', { status: 404 });
    return new Response(upstream.body, {
      headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' },
    });
  }

  // One photo's ORIGINAL as a download (the icon on each grid tile / in the lightbox).
  // Only photos that are in the grid, same as the ZIPs.
  if (parts.length === 5 && parts[3] === 'download') {
    const model = buildGalleryModel(project, deliveryOpts(jobId, env), pendingCopies);
    if (!model.originalPhotoIds.includes(parts[4])) return notFound();
    const rec = ((project.data && project.data.photos) || []).find((p) => p.photoId === parts[4]);
    const upstream = await callPhotoSync(env, `/render/${encodeURIComponent(jobId)}/${encodeURIComponent(parts[4])}`);
    if (!upstream.ok) return new Response('Could not prepare this download. Please try again or contact Franky.', { status: upstream.status === 404 ? 404 : 502 });
    const headers = {
      'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
      'content-disposition': attachmentDisposition(rec && rec.filename),
      'cache-control': 'no-store',
    };
    const len = upstream.headers.get('content-length');
    if (len) headers['content-length'] = len;
    return new Response(upstream.body, { headers });
  }

  return notFound();
}

// GET /admin?admin=<ADMIN_TOKEN> -- read-only directory of every Job's
// delivery page. Same query-param-token shape as Feature Sheet Builder's
// own admin page (a bookmarkable-but-secret link, not a curl-only header).
// GET /deliver/<address-slug>/<token>[/go/<KEY>] -- the Delivery Hub (hub.js). The slug is
// cosmetic; a wrong token looks exactly like a missing Job. /go/<KEY> is the gate: it
// re-checks paid/unlocked on every hit, so a locked page never carries any target link.
async function handleHub(parts, env, url) {
  const notFound = () => html(renderNotFoundHub(), 404);
  if (!isHubToken(parts[2])) return notFound();
  const sb = createSupabase(env);
  const row = await sb.getHubByToken(parts[2]);
  if (!row) return notFound();
  const base = `/${parts.slice(0, 3).map(encodeURIComponent).join('/')}`;
  const [project, galleryToken] = await Promise.all([sb.getProject(row.job_id), sb.getGalleryTokenForJob(row.job_id)]);

  // ?for=client: the forwardable client view (hub.js#renderClientView); it also governs /go/<KEY> below.
  const forClient = Boolean(url && url.searchParams.get('for') === 'client');

  if (parts.length === 3 && forClient) {
    return html(renderClientView(buildHubModel(row, project, galleryToken), { base }), 200, { 'cache-control': 'no-store' });
  }

  if (parts.length === 3) {
    // ?pay=1 (from the invoice page's "Ready to pay") opens the pay dialog right away.
    return html(renderHubPage(buildHubModel(row, project, galleryToken), { base, openKey: url && url.searchParams.get('pay') ? 'pay' : '' }), 200, { 'cache-control': 'no-store' });
  }

  // The invoice on its own page, and the PDF behind it. The PDF is fetched from Wave on every hit (Wave regenerates
  // it, so a paid invoice shows as paid) and streamed to the visitor: inline for the page's viewer, as a download
  // with ?download=1 -- Wave's own link only ever downloads. The source URL comes from the database (Wave's PDF host
  // only, see hub.js#pdfSourceUrl), never from the request.
  if (parts.length === 4 && parts[3] === 'invoice') {
    if (!pdfSourceUrl(row)) return html(renderNotReadyHub(base), 404, { 'cache-control': 'no-store' });
    return html(renderInvoicePage(buildHubModel(row, project, galleryToken), { base }), 200, { 'cache-control': 'no-store' });
  }
  if (parts.length === 4 && parts[3] === 'invoice.pdf') {
    const src = pdfSourceUrl(row);
    if (!src) return notFound();
    const upstream = await fetch(src, { redirect: 'follow' });
    const type = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !/pdf/i.test(type)) return html(renderNotReadyHub(base), 502, { 'cache-control': 'no-store' });
    const address = (project && project.data && project.data.address) || '';
    const name = `Invoice${address ? ' - ' + address : ''}.pdf`;
    const download = url && url.searchParams.get('download');
    return new Response(upstream.body, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `${download ? 'attachment' : 'inline'}; ${attachmentDisposition(name).replace(/^attachment;\s*/, '')}`,
        'cache-control': 'no-store',
      },
    });
  }

  // Polled by the locked page after the visitor opens the pay dialog, so it can unlock itself the
  // moment the Job is paid / unlocked (no manual refresh), or refresh the owed amount after a partial payment.
  // Carries nothing but those two values.
  if (parts.length === 4 && parts[3] === 'status') {
    return json({ unlocked: isUnlocked(row), paid: !!row.paid, remainingCents: remainingCents(row) }, 200, { 'cache-control': 'no-store' });
  }

  if (parts.length === 5 && parts[3] === 'go' && isLineKey(parts[4])) {
    // Locked: back to the hub with the "please pay" dialog open (never a target).
    if (!isUnlocked(row)) {
      const model = buildHubModel(row, project, galleryToken);
      return html(forClient ? renderClientView(model, { base }) : renderHubPage(model, { base, openKey: parts[4] }), 200, { 'cache-control': 'no-store' });
    }
    const target = resolveTarget(parts[4], row, project, galleryToken);
    if (!target) return html(renderNotReadyHub(base), 503, { 'cache-control': 'no-store' });
    return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'no-store' } });
  }

  return notFound();
}

// POST /webhooks/wave -- Wave's invoice events (wave-webhook.js has the format + signature rules).
// A fully paid invoice marks its Job paid (source 'wave'); a partial payment is only recorded. Always
// answers 200 once the signature is valid (unmatched / ignored / duplicate included) -- Wave disables a
// subscription after 10 consecutive failed deliveries, so only a bad signature or our own error fails.
async function handleWaveWebhook(request, env) {
  // Before the signing secret exists (Wave only shows it AFTER the endpoint URL is saved, and it checks the URL
  // answers with a success first) there is nothing to verify and nothing to lose: answer 200 and do nothing. Once
  // the secret is set this endpoint is strict (401 for anything unsigned).
  if (!env.WAVE_WEBHOOK_SECRET) return json({ ok: true, configured: false });
  const rawBody = await request.text();
  const ok = await verifyWaveSignature({ header: request.headers.get('x-wave-signature'), rawBody, secret: env.WAVE_WEBHOOK_SECRET });
  if (!ok) return json({ error: 'bad signature' }, 401);

  let evt;
  try {
    evt = JSON.parse(rawBody);
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  if (!evt || typeof evt.event_id !== 'string' || typeof evt.event_type !== 'string') return json({ error: 'not a Wave event' }, 400);

  const sb = createSupabase(env);
  const c = classifyWaveEvent(evt);
  const fresh = await sb.insertWaveEvent({ event_id: evt.event_id, event_type: evt.event_type, invoice_id: c.invoiceId, business_id: evt.business_id, payload: evt });
  if (!fresh) return json({ ok: true, duplicate: true });

  let result = 'ignored';
  let jobId = null;
  if (c.kind !== 'ignore') {
    const row = await sb.getHubByWaveInvoice(c.invoiceId);
    if (!row) {
      result = 'no matching job';
    } else {
      jobId = row.job_id;
      if (c.kind === 'paid') {
        await sb.patchHub(jobId, {
          paid: true, paid_source: 'wave', paid_at: c.paidDate ? new Date(c.paidDate).toISOString() : new Date().toISOString(),
          wave_paid_cents: c.paidCents, wave_remaining_cents: 0,
        });
        result = 'paid';
      } else {
        await sb.patchHub(jobId, { wave_paid_cents: c.paidCents, wave_remaining_cents: c.remainingCents });
        result = 'partial';
      }
    }
  }
  await sb.updateWaveEvent(evt.event_id, { job_id: jobId, result });
  return json({ ok: true, result });
}

async function handleAdmin(url, env) {
  const token = url.searchParams.get('admin') || '';
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return html('unauthorized', 401);

  const sb = createSupabase(env);
  const rows = await sb.listProjects();
  // Every Job gets its Gallery link automatically (like its All in One page,
  // which exists as soon as the Job does) -- no button to press.
  const galleryTokens = await sb.ensureGalleryTokens(rows.map((r) => r.id));
  const hubs = await sb.listHubs();
  const model = buildAdminModel(rows, galleryTokens, hubs);
  return html(renderAdminPage(model, { origin: url.origin }));
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

// POST /admin/hub/<jobId> (bearer ADMIN_TOKEN) {paid?: bool, unlocked?: bool} -- Franky's
// "mark paid" / "deliver first" switches on the /admin directory.
async function handleAdminSetHub(jobId, request, env) {
  const auth = request.headers.get('authorization') || '';
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'unauthorized' }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const flags = {};
  if (typeof body.paid === 'boolean') flags.paid = body.paid;
  if (typeof body.unlocked === 'boolean') flags.unlocked = body.unlocked;
  if (Object.keys(flags).length === 0) return json({ error: 'no recognized fields (paid, unlocked)' }, 400);
  const sb = createSupabase(env);
  // A Job Wave says is paid can't be un-paid from here (that's the point of the greyed-out tick);
  // ticking Paid on it again is a harmless no-op that keeps the 'wave' source.
  const existing = await sb.getHubByJobId(jobId);
  if (existing && existing.paid && existing.paid_source === 'wave' && 'paid' in flags) {
    if (flags.paid === false) return json({ error: 'paid through Wave -- cannot be unticked' }, 409);
    delete flags.paid;
    if (Object.keys(flags).length === 0) return json({ jobId, paid: true, unlocked: !!existing.unlocked });
  }
  const row = await sb.setHubFlags(jobId, flags);
  if (!row) return json({ error: 'no delivery hub for this job yet (run Create/Update Job first)' }, 404);
  return json({ jobId, paid: !!row.paid, unlocked: !!row.unlocked });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (request.method === 'GET' && parts.length === 0) {
      return new Response('franvision-delivery-page: ok', { headers: { 'content-type': 'text/plain' } });
    }

    // Delivery Hub: /deliver/<address-slug>/<token>[/go/<KEY>] (3+ segments, so it never
    // meets the 2-segment pretty URL below).
    if (request.method === 'GET' && parts[0] === 'deliver' && parts.length >= 3) {
      try {
        return await handleHub(parts.map(decodeURIComponent), env, url);
      } catch (err) {
        console.log('hub_error', { error: String(err) });
        return html(renderNotFoundHub(), 500);
      }
    }

    // Standalone Gallery page: /delivery/<address-slug>/<token>[/...] -- 3+
    // segments under /delivery, so it can't collide with the delivery page's
    // own /delivery/<jobId> (2 segments) -- but must be checked BEFORE that
    // route, which would otherwise take the slug for a jobId. Not linked from the delivery page;
    // the link goes in the Delivery Email.
    if (request.method === 'GET' && parts[0] === 'delivery' && parts.length >= 3) {
      try {
        return await handleGallery(parts.map(decodeURIComponent), env);
      } catch (err) {
        console.log('gallery_error', { error: String(err) });
        return html(renderGalleryNotFoundPage(), 500);
      }
    }

    if (request.method === 'GET' && parts[0] === 'delivery' && parts[1]) {
      try {
        return await handleDelivery(decodeURIComponent(parts[1]), env);
      } catch (err) {
        console.log('delivery_render_error', { jobId: parts[1], error: String(err) });
        return html(renderNotFoundPage(parts[1]), 500);
      }
    }

    // Pretty URL: /<address-slug>/<jobId> (see render.js#deliveryPath). The
    // first segment is never inspected -- only the second (the jobId) does
    // the actual lookup -- so this works no matter what the address slug
    // says, and stays correct even if an address is edited after the link
    // was generated/shared. Excludes a first segment of "admin" so this can
    // never shadow the /admin routes below regardless of check order (a
    // real address slug colliding with "admin" is effectively impossible
    // anyway).
    if (request.method === 'GET' && parts.length === 2 && parts[0] !== 'admin') {
      try {
        return await handleDelivery(decodeURIComponent(parts[1]), env);
      } catch (err) {
        console.log('delivery_render_error', { jobId: parts[1], error: String(err) });
        return html(renderNotFoundPage(parts[1]), 500);
      }
    }

    if (request.method === 'GET' && parts[0] === 'admin' && parts.length === 1) {
      try {
        return await handleAdmin(url, env);
      } catch (err) {
        console.log('admin_list_error', { error: String(err) });
        return html('error loading admin directory', 500);
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

    if ((request.method === 'GET' || request.method === 'HEAD') && parts[0] === 'webhooks' && parts[1] === 'wave' && parts.length === 2) {
      return json({ ok: true, service: 'wave-webhook' });   // reachability check only
    }

    if (request.method === 'POST' && parts[0] === 'webhooks' && parts[1] === 'wave' && parts.length === 2) {
      try {
        return await handleWaveWebhook(request, env);
      } catch (err) {
        console.log('wave_webhook_error', { error: String(err) });
        return json({ error: 'internal error' }, 500);   // non-2xx -> Wave retries
      }
    }

    if (request.method === 'POST' && parts[0] === 'admin' && parts[1] === 'hub' && parts[2]) {
      try {
        return await handleAdminSetHub(decodeURIComponent(parts[2]), request, env);
      } catch (err) {
        console.log('admin_set_hub_error', { jobId: parts[2], error: String(err) });
        return json({ error: String(err) }, 500);
      }
    }

    return new Response('not found', { status: 404 });
  },
};
