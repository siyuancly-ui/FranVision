/*
 * FranVision Feature Sheet Builder -- local dev server.
 *
 * Zero dependencies (Node's built-in http/fs/path only), same spirit as
 * job-generator/server.js. Serves the editor UI (public/) and a small
 * JSON + binary API backed by storage.js (LocalDiskStorage for now,
 * SupabaseStorage later -- same interface, chosen here by env).
 *
 *   node server.js            -> http://localhost:4180
 *   PORT=5000 node server.js
 *
 * API
 *   POST   /api/projects                       {?propertyInfo,?agentInfo,?photos,?templateId} -> {projectId, project}
 *   GET    /api/projects/:id                    -> project
 *   PUT    /api/projects/:id                    patch -> project
 *   POST   /api/projects/:id/confirm            {confirmed=true} -> project
 *   POST   /api/projects/:id/photos             raw image body, X-Filename header -> photoMeta
 *   DELETE /api/projects/:id/photos/:photoId    -> project
 *   GET    /photos/:id/:photoId                 -> original image bytes
 *   GET    /thumbs/:id/:photoId                 -> thumbnail bytes (falls back to original)
 *   GET    /api/templates                       -> { defaultId, templates:{...} }
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const storageLib = require('./storage.js');
const templates = require('./templates/registry.js');

// Honour PORT=0 (ephemeral, used by api.test.js) -- `parseInt('0') || 4180`
// would wrongly fall through to 4180.
const PORT = (process.env.PORT !== undefined && process.env.PORT !== '' && !Number.isNaN(parseInt(process.env.PORT, 10)))
  ? parseInt(process.env.PORT, 10)
  : 4180;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.FSB_DATA_DIR || path.join(__dirname, 'data');
const MAX_UPLOAD = 30 * 1024 * 1024; // 30 MB per photo

// Storage backend. Only 'local' exists today; the hook is here so
// FSB_STORAGE=supabase can select a drop-in replacement later.
const storage = (function pickStorage() {
  switch ((process.env.FSB_STORAGE || 'local').toLowerCase()) {
    case 'local':
    default:
      return new storageLib.LocalDiskStorage(DATA_DIR);
  }
})();

// Modules that also run in the browser (loaded as classic <script>), kept
// as one implementation instead of a drifting copy in public/.
const SHARED_FILES = {
  '/shared/template-config.js': path.join(__dirname, 'templates', 'jason-fs-v1', 'template-config.js'),
  '/shared/registry.js': path.join(__dirname, 'templates', 'registry.js'),
  '/shared/crop-math.js': path.join(__dirname, 'crop-math.js'),
  // fsb-v2 template system (geometry / themes / modules / engine / registry)
  '/shared/v2/text-util.js': path.join(__dirname, 'templates', 'fsb-v2', 'text-util.js'),
  '/shared/v2/geometry.js': path.join(__dirname, 'templates', 'fsb-v2', 'geometry.js'),
  '/shared/v2/themes.js': path.join(__dirname, 'templates', 'fsb-v2', 'themes.js'),
  '/shared/v2/modules.js': path.join(__dirname, 'templates', 'fsb-v2', 'modules.js'),
  '/shared/v2/layout-engine.js': path.join(__dirname, 'templates', 'fsb-v2', 'layout-engine.js'),
  '/shared/v2/registry.js': path.join(__dirname, 'templates', 'fsb-v2', 'registry.js'),
  '/shared/v2/assets/flourish.svg': path.join(__dirname, 'templates', 'fsb-v2', 'assets', 'flourish.svg'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function readBinaryBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) { req.destroy(); return reject(new Error('Upload exceeds ' + MAX_UPLOAD + ' bytes')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveFile(res, filePath, cache) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cache || 'no-cache',
    });
    res.end(data);
  });
}

function serveStatic(req, res, urlPath) {
  if (SHARED_FILES[urlPath]) return serveFile(res, SHARED_FILES[urlPath], 'no-cache');

  // Template assets (logo, headshot, future backgrounds).
  if (urlPath.startsWith('/template-assets/')) {
    const rel = urlPath.replace('/template-assets/', '');
    const abs = path.join(__dirname, 'templates', rel);
    if (!abs.startsWith(path.join(__dirname, 'templates'))) { res.writeHead(403); res.end('Forbidden'); return; }
    return serveFile(res, abs, 'public, max-age=3600');
  }

  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  serveFile(res, filePath, 'no-cache');
}

function sendImage(res, filePath) {
  if (!filePath) { res.writeHead(404); res.end('Not found'); return; }
  serveFile(res, filePath, 'public, max-age=300');
}

async function handleApi(req, res, parts, urlPath) {
  // parts: path split by '/', no leading empty. e.g. ['api','projects','abc']
  const method = req.method;

  // ---- image serving -------------------------------------------------
  if (parts[0] === 'photos' && parts.length === 3 && method === 'GET') {
    return sendImage(res, storage.getPhotoPath(parts[1], parts[2], 'original'));
  }
  if (parts[0] === 'thumbs' && parts.length === 3 && method === 'GET') {
    return sendImage(res, storage.getPhotoPath(parts[1], parts[2], 'thumb'));
  }

  if (parts[0] !== 'api') { res.writeHead(404); res.end('Not found'); return; }

  // ---- templates ----------------------------------------------------
  if (parts[1] === 'templates' && method === 'GET') {
    return sendJson(res, 200, { defaultId: templates.DEFAULT_ID, ids: templates.ids() });
  }

  // ---- admin (dev; Supabase uses the edge fn) ------------------------
  if (parts[1] === 'admin') {
    const want = process.env.ADMIN_TOKEN || 'dev-admin';
    const got = req.headers['x-admin-token'] || '';
    if (got !== want) return sendJson(res, 401, { error: 'unauthorized' });

    if (parts[2] === 'projects' && method === 'GET') {
      return sendJson(res, 200, { projects: await storage.listProjects() });
    }
    if (parts[2] === 'trash' && parts.length === 3 && method === 'GET') {
      return sendJson(res, 200, { projects: await storage.listProjects({ trashed: true }) });
    }
    if (parts[2] === 'trash' && parts[3] === 'empty' && method === 'POST') {
      return sendJson(res, 200, { purged: await storage.emptyTrash() });
    }
  }

  // ---- projects ---------------------------------------------------
  if (parts[1] === 'projects') {
    // POST /api/projects
    if (parts.length === 2 && method === 'POST') {
      const body = await readJsonBody(req);
      const project = await storage.createProject(body);
      return sendJson(res, 201, { projectId: project.projectId, project });
    }

    const id = parts[2];

    // GET/PUT /api/projects/:id
    if (parts.length === 3 && method === 'GET') {
      const project = await storage.getProject(id);
      return project ? sendJson(res, 200, { project }) : sendJson(res, 404, { error: 'Project not found' });
    }
    if (parts.length === 3 && method === 'PUT') {
      const patch = await readJsonBody(req);
      const project = await storage.updateProject(id, patch);
      return project ? sendJson(res, 200, { project }) : sendJson(res, 404, { error: 'Project not found' });
    }
    // DELETE = soft delete -> recycle bin
    if (parts.length === 3 && method === 'DELETE') {
      const ok = await storage.deleteProject(id);
      return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Project not found' });
    }

    // POST /api/projects/:id/restore   (out of the recycle bin)
    if (parts.length === 4 && parts[3] === 'restore' && method === 'POST') {
      const project = await storage.restoreProject(id);
      return project ? sendJson(res, 200, { project }) : sendJson(res, 404, { error: 'Project not found' });
    }
    // POST /api/projects/:id/purge     (permanent, single)
    if (parts.length === 4 && parts[3] === 'purge' && method === 'POST') {
      const ok = await storage.purgeProject(id);
      return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Project not found' });
    }

    // POST /api/projects/:id/duplicate
    if (parts.length === 4 && parts[3] === 'duplicate' && method === 'POST') {
      const project = await storage.duplicateProject(id);
      return project
        ? sendJson(res, 201, { projectId: project.projectId, project })
        : sendJson(res, 404, { error: 'Project not found' });
    }

    // POST /api/projects/:id/confirm
    if (parts.length === 4 && parts[3] === 'confirm' && method === 'POST') {
      const body = await readJsonBody(req);
      const confirmed = body.confirmed === undefined ? true : !!body.confirmed;
      const project = await storage.setConfirmed(id, confirmed);
      return project ? sendJson(res, 200, { project }) : sendJson(res, 404, { error: 'Project not found' });
    }

    // POST /api/projects/:id/photos   (raw binary)
    if (parts.length === 4 && parts[3] === 'photos' && method === 'POST') {
      const buffer = await readBinaryBody(req);
      const meta = await storage.savePhoto(id, {
        buffer,
        filename: req.headers['x-filename'] ? decodeURIComponent(req.headers['x-filename']) : '',
        contentType: req.headers['content-type'] || '',
      });
      return meta ? sendJson(res, 201, { photo: meta }) : sendJson(res, 400, { error: 'Could not save photo (project missing or empty body)' });
    }

    // DELETE /api/projects/:id/photos/:photoId
    if (parts.length === 5 && parts[3] === 'photos' && method === 'DELETE') {
      const project = await storage.deletePhoto(id, parts[4]);
      return project ? sendJson(res, 200, { project }) : sendJson(res, 404, { error: 'Project or photo not found' });
    }
    // DELETE /api/projects/:id/photos   -> clear the whole library
    if (parts.length === 4 && parts[3] === 'photos' && method === 'DELETE') {
      const project = await storage.clearPhotos(id);
      return project ? sendJson(res, 200, { project }) : sendJson(res, 404, { error: 'Project not found' });
    }
  }

  sendJson(res, 404, { error: 'Unknown API route: ' + method + ' ' + urlPath });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURI(req.url.split('?')[0]);
  const parts = urlPath.split('/').filter(Boolean);

  const isApi = parts[0] === 'api' || parts[0] === 'photos' || parts[0] === 'thumbs';
  if (isApi) {
    handleApi(req, res, parts, urlPath).catch((err) => {
      sendJson(res, 500, { error: err.message || String(err) });
    });
  } else {
    serveStatic(req, res, urlPath);
  }
});

server.listen(PORT, () => {
  console.log('FranVision Feature Sheet Builder -> http://localhost:' + PORT);
  console.log('  data dir : ' + DATA_DIR);
  console.log('  storage  : ' + (process.env.FSB_STORAGE || 'local'));
});

module.exports = server;
