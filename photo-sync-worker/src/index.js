// FranVision Photo Sync Worker -- entry point.
//
//   fetch      : Dropbox webhook (GET handshake + POST notify) and /admin/*
//   queue      : the sync engine -- delta / photo-batch / backfill messages
//   scheduled  : every 2 min, enqueue a {type:"delta"} reconciliation pass
//
// See DESIGN.md for the full flow.

import { verifyDropboxSignature, timingSafeEqual } from './webhook.js';
import { createDropbox } from './dropbox.js';
import { createSupabase } from './supabase.js';
import { createStream } from './stream.js';
import { runDelta, processPhotoBatch, runBackfill, processRenderRetryPoll } from './sync.js';
import { processVideoBatch, processVideoPoll } from './video-sync.js';
import { processTourLinkBatch } from './tour-link-sync.js';
import { CORS, parseRenderPath, handleRender } from './render.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const log = (obj) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));

function makeDeps(env) {
  return {
    dbx: createDropbox(env),
    sb: createSupabase(env),
    stream: createStream(env),
    enqueue: (msg) => env.SYNC_QUEUE.send(msg),
    now: () => new Date().toISOString(),
  };
}

function adminAuthed(request, env) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return !!m && !!env.ADMIN_TOKEN && timingSafeEqual(m[1], env.ADMIN_TOKEN);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'GET' && pathname === '/') {
      return new Response('franvision-photo-sync ok\n', { headers: { 'Content-Type': 'text/plain' } });
    }

    // Dropbox webhook verification handshake
    if (request.method === 'GET' && pathname === '/webhook') {
      const challenge = url.searchParams.get('challenge') || '';
      return new Response(challenge, {
        headers: { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' },
      });
    }

    // Dropbox change notification
    if (request.method === 'POST' && pathname === '/webhook') {
      const raw = await request.text();
      const valid = await verifyDropboxSignature(
        raw,
        request.headers.get('X-Dropbox-Signature'),
        env.DROPBOX_APP_SECRET,
      );
      if (!valid) {
        log({ evt: 'webhook_bad_signature' });
        return new Response('invalid signature', { status: 403 });
      }
      // Respond fast; do the enqueue in the background.
      ctx.waitUntil(
        env.SYNC_QUEUE.send({ type: 'delta' }).catch((err) =>
          log({ evt: 'webhook_enqueue_failed', error: String(err && err.message || err) }),
        ),
      );
      return new Response('', { status: 200 });
    }

    // 2048 render of one synced photo for the Feature Sheet Builder's PDF
    // export (token-gated; see render.js)
    if (pathname.startsWith('/render/')) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      const ids = parseRenderPath(pathname);
      if (request.method !== 'GET' || !ids) return json({ error: 'not found' }, 404);
      return handleRender(request, env, makeDeps(env), ids, log);
    }

    // Manual backfill (cursor-independent)
    if (request.method === 'POST' && pathname === '/admin/backfill') {
      if (!adminAuthed(request, env)) return json({ error: 'unauthorized' }, 401);
      let body = {};
      try { body = await request.json(); } catch { /* empty body = full sweep */ }
      const jobId = body && body.jobId ? String(body.jobId) : null;
      await env.SYNC_QUEUE.send({ type: 'backfill', jobId });
      log({ evt: 'backfill_queued', jobId: jobId || 'all' });
      return json({ queued: true, scope: jobId || 'all' });
    }

    if (request.method === 'GET' && pathname === '/admin/status') {
      if (!adminAuthed(request, env)) return json({ error: 'unauthorized' }, 401);
      try {
        const state = await createSupabase(env).getSyncState();
        return json({
          hasCursor: !!(state && state.cursor),
          lockedUntil: state && state.locked_until,
          lastRunAt: state && state.last_run_at,
          stats: state && state.stats,
          updatedAt: state && state.updated_at,
        });
      } catch (err) {
        return json({ error: String(err && err.message || err) }, 500);
      }
    }

    return json({ error: 'not found' }, 404);
  },

  async queue(batch, env, ctx) {
    const deps = makeDeps(env);
    for (const message of batch.messages) {
      const body = message.body || {};
      try {
        if (body.type === 'delta') {
          await runDelta(env, deps);
        } else if (body.type === 'photo-batch') {
          await processPhotoBatch(env, deps, body);
        } else if (body.type === 'video-batch') {
          await processVideoBatch(env, deps, body);
        } else if (body.type === 'video-poll') {
          await processVideoPoll(env, deps);
        } else if (body.type === 'tour-link-batch') {
          await processTourLinkBatch(env, deps, body);
        } else if (body.type === 'backfill') {
          await runBackfill(env, deps, { jobId: body.jobId || null });
        } else if (body.type === 'render-retry-poll') {
          await processRenderRetryPoll(env, deps);
        } else {
          log({ evt: 'queue_unknown_type', body });
        }
        message.ack();
      } catch (err) {
        log({ evt: 'queue_message_failed', type: body.type, attempts: message.attempts, error: String(err && err.message || err) });
        message.retry();
      }
    }
    void ctx;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      env.SYNC_QUEUE.send({ type: 'delta' }).catch((err) =>
        log({ evt: 'cron_enqueue_failed', error: String(err && err.message || err) }),
      ),
    );
    ctx.waitUntil(
      env.SYNC_QUEUE.send({ type: 'video-poll' }).catch((err) =>
        log({ evt: 'cron_video_poll_enqueue_failed', error: String(err && err.message || err) }),
      ),
    );
    ctx.waitUntil(
      env.SYNC_QUEUE.send({ type: 'render-retry-poll' }).catch((err) =>
        log({ evt: 'cron_render_retry_poll_enqueue_failed', error: String(err && err.message || err) }),
      ),
    );
    void event;
  },
};
