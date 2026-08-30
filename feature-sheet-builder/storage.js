/*
 * storage.js -- project + photo persistence.
 *
 * Exposes a small async interface and one implementation, LocalDiskStorage,
 * that writes to ./data. A SupabaseStorage with the SAME interface will be
 * dropped in later (Postgres row for project.json, Storage bucket for the
 * originals); server.js picks the implementation via an env switch and
 * nothing else changes. The client only ever talks to server.js, so the
 * swap is invisible to the browser too.
 *
 * Interface:
 *   createProject(initial)            -> project
 *   getProject(id)                    -> project | null
 *   updateProject(id, patch)          -> project | null
 *   setConfirmed(id, bool)            -> project | null
 *   savePhoto(id, {buffer, filename, contentType}) -> photoMeta | null
 *   deletePhoto(id, photoId)          -> project | null
 *   getPhotoPath(id, photoId, kind)   -> absolute path | null   (kind: 'original' | 'thumb')
 *   listProjectIds()                  -> string[]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const templates = require('./templates/registry.js');
const thumbnailer = require('./thumbnailer.js');

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const EXT_BY_TYPE = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png' };
const ALLOWED_EXT = ['jpg', 'jpeg', 'png'];

function newId(bytes) {
  return crypto.randomBytes(bytes || 9).toString('base64url').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12);
}

function nowIso() { return new Date().toISOString(); }

function safeId(id) { return typeof id === 'string' && ID_RE.test(id); }

function extFor(filename, contentType) {
  const byType = EXT_BY_TYPE[String(contentType || '').toLowerCase()];
  if (byType) return byType;
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filename || ''));
  const ext = m ? m[1].toLowerCase() : '';
  return ALLOWED_EXT.indexOf(ext) >= 0 ? (ext === 'jpeg' ? 'jpg' : ext) : 'jpg';
}

// Deep-ish merge tailored to the project shape: replace propertyInfo /
// agentInfo wholesale (the form always sends every field), merge pages by
// slot id (so the editor can PUT just the slots it changed).
function applyPatch(project, patch) {
  if (!patch || typeof patch !== 'object') return project;

  if (patch.templateId && templates.has(patch.templateId)) project.templateId = patch.templateId;
  // fsb-v2 top-level fields
  if (patch.templateSystem) project.templateSystem = patch.templateSystem;
  if (patch.colorTheme) project.colorTheme = patch.colorTheme;
  if (patch.topPhotoStyle) project.topPhotoStyle = patch.topPhotoStyle;
  if (patch.propertyInfo && typeof patch.propertyInfo === 'object') {
    project.propertyInfo = Object.assign({}, project.propertyInfo, patch.propertyInfo);
  }
  if (patch.agentInfo && typeof patch.agentInfo === 'object') {
    project.agentInfo = Object.assign({}, project.agentInfo, patch.agentInfo);
  }
  if ('agentInfo2' in patch && patch.agentInfo2 !== undefined) {
    project.agentInfo2 = patch.agentInfo2 && typeof patch.agentInfo2 === 'object'
      ? Object.assign({}, project.agentInfo2 || {}, patch.agentInfo2)
      : patch.agentInfo2; // null clears it
  }
  // The client is authoritative for the photo list (it holds every uploaded
  // photo's metadata in memory); a save replaces the stored array wholesale.
  if (Array.isArray(patch.photos)) {
    project.photos = patch.photos;
  }
  if (patch.pages && typeof patch.pages === 'object') {
    ['page1', 'page2'].forEach((pk) => {
      if (patch.pages[pk] && patch.pages[pk].slots && typeof patch.pages[pk].slots === 'object') {
        project.pages[pk] = project.pages[pk] || { slots: {} };
        project.pages[pk].slots = project.pages[pk].slots || {};
        Object.keys(patch.pages[pk].slots).forEach((sid) => {
          const incoming = patch.pages[pk].slots[sid] || {};
          const cur = project.pages[pk].slots[sid] || { photoId: null, positionX: 0, positionY: 0, scale: 1 };
          project.pages[pk].slots[sid] = {
            photoId: incoming.photoId !== undefined ? incoming.photoId : cur.photoId,
            positionX: num(incoming.positionX, cur.positionX),
            positionY: num(incoming.positionY, cur.positionY),
            scale: num(incoming.scale, cur.scale),
          };
        });
      }
    });
  }
  if (typeof patch.confirmed === 'boolean') {
    project.confirmed = patch.confirmed;
    project.confirmedAt = patch.confirmed ? (project.confirmedAt || nowIso()) : null;
  }
  return project;
}

function num(v, dflt) { return (typeof v === 'number' && isFinite(v)) ? v : dflt; }

function clearPhotoRefs(project, photoId) {
  ['page1', 'page2'].forEach((pk) => {
    const slots = (project.pages[pk] && project.pages[pk].slots) || {};
    Object.keys(slots).forEach((sid) => {
      if (slots[sid] && slots[sid].photoId === photoId) {
        slots[sid] = { photoId: null, positionX: 0, positionY: 0, scale: 1 };
      }
    });
  });
  if (project.agentInfo) {
    if (project.agentInfo.headshotPhotoId === photoId) project.agentInfo.headshotPhotoId = null;
    if (project.agentInfo.brokerageLogoPhotoId === photoId) project.agentInfo.brokerageLogoPhotoId = null;
  }
}

class LocalDiskStorage {
  constructor(dataDir) {
    this.dataDir = dataDir || path.join(__dirname, 'data');
    fs.mkdirSync(this.dataDir, { recursive: true });
    // Per-project promise chain. Concurrent uploads + autosaves all do a
    // read-modify-write of project.json; without serialising them the last
    // writer wins and the others' changes (e.g. freshly uploaded photos)
    // are silently dropped. Slow work (writing the original file, making
    // the thumbnail) stays OUTSIDE the lock -- it uses unique filenames.
    this._locks = Object.create(null);
  }

  _withLock(id, fn) {
    var prev = this._locks[id] || Promise.resolve();
    var run = prev.then(fn, fn);
    this._locks[id] = run.then(function () {}, function () {});
    return run;
  }

  _projDir(id) { return path.join(this.dataDir, id); }
  _projFile(id) { return path.join(this._projDir(id), 'project.json'); }
  _photosDir(id) { return path.join(this._projDir(id), 'photos'); }
  _thumbsDir(id) { return path.join(this._projDir(id), 'thumbs'); }

  _read(id) {
    try {
      return JSON.parse(fs.readFileSync(this._projFile(id), 'utf8'));
    } catch (_e) {
      return null;
    }
  }

  _write(project) {
    const dir = this._projDir(project.projectId);
    fs.mkdirSync(dir, { recursive: true });
    project.updatedAt = nowIso();
    fs.writeFileSync(this._projFile(project.projectId), JSON.stringify(project, null, 2), 'utf8');
    return project;
  }

  async createProject(initial) {
    initial = initial || {};
    const id = newId();
    let project;
    if (initial.templateSystem === 'fsb-v2') {
      // Minimal v2 scaffold; the client is authoritative for geometry.
      project = {
        projectId: id,
        templateSystem: 'fsb-v2',
        colorTheme: initial.colorTheme || 'navy',
        topPhotoStyle: initial.topPhotoStyle || 'wide',
        propertyInfo: { address: '', city: '', description: '',
          bedrooms: '', bathrooms: '', garage: '', onlineTourUrl: '' },
        agentInfo: { name: '', credentials: '', busPhone: '', cellPhone: '', email: '',
          brokerage: '', brokerageAddress: '', website: '',
          headshotPhotoId: null, brokerageLogoPhotoId: null },
        agentInfo2: null,
        photos: [],
        pages: { page1: { slots: {} }, page2: { slots: {} } },
        confirmed: false, confirmedAt: null,
        createdAt: nowIso(), updatedAt: nowIso(),
      };
    } else {
      const tplId = templates.has(initial.templateId) ? initial.templateId : templates.DEFAULT_ID;
      const tpl = templates.get(tplId);
      project = Object.assign(tpl.blankProject(), {
        projectId: id, templateId: tplId, createdAt: nowIso(), updatedAt: nowIso(),
      });
    }
    // Optional seed data (property/agent info, pre-attached photos) so the
    // wider FranVision platform can auto-create a filled project from a
    // delivery/job later.
    applyPatch(project, {
      templateSystem: initial.templateSystem,
      colorTheme: initial.colorTheme,
      topPhotoStyle: initial.topPhotoStyle,
      propertyInfo: initial.propertyInfo,
      agentInfo: initial.agentInfo,
      agentInfo2: initial.agentInfo2,
      pages: initial.pages,
    });
    if (Array.isArray(initial.photos)) project.photos = initial.photos;

    fs.mkdirSync(this._photosDir(id), { recursive: true });
    fs.mkdirSync(this._thumbsDir(id), { recursive: true });
    return this._write(project);
  }

  async getProject(id) {
    if (!safeId(id)) return null;
    return this._read(id);
  }

  async updateProject(id, patch) {
    if (!safeId(id)) return null;
    return this._withLock(id, () => {
      const project = this._read(id);
      if (!project) return null;
      applyPatch(project, patch);
      return this._write(project);
    });
  }

  async setConfirmed(id, confirmed) {
    return this.updateProject(id, { confirmed: !!confirmed });
  }

  async savePhoto(id, file) {
    if (!safeId(id)) return null;
    if (!this._read(id)) return null;
    if (!file || !file.buffer || !file.buffer.length) return null;

    const photoId = newId(9);
    const ext = extFor(file.filename, file.contentType);
    fs.mkdirSync(this._photosDir(id), { recursive: true });
    fs.mkdirSync(this._thumbsDir(id), { recursive: true });

    // Slow work first, outside the lock (unique filenames -> no contention).
    const originalPath = path.join(this._photosDir(id), photoId + '.' + ext);
    fs.writeFileSync(originalPath, file.buffer);

    const thumbPath = path.join(this._thumbsDir(id), photoId + '.jpg');
    const info = await thumbnailer.process(originalPath, thumbPath);

    const meta = {
      photoId: photoId,
      filename: String(file.filename || (photoId + '.' + ext)),
      ext: ext,
      width: info.width || 0,
      height: info.height || 0,
      hasThumb: !!info.thumbOk,
      bytes: file.buffer.length,
      uploadedAt: nowIso(),
    };

    // Only the project.json append is serialised.
    return this._withLock(id, () => {
      const fresh = this._read(id);
      if (!fresh) {
        try { fs.unlinkSync(originalPath); } catch (_e) {}
        try { fs.unlinkSync(thumbPath); } catch (_e) {}
        return null;
      }
      fresh.photos.push(meta);
      this._write(fresh);
      return meta;
    });
  }

  async deletePhoto(id, photoId) {
    if (!safeId(id) || !safeId(photoId)) return null;
    return this._withLock(id, () => {
      const project = this._read(id);
      if (!project) return null;

      const meta = project.photos.find((p) => p.photoId === photoId);
      if (meta) {
        try { fs.unlinkSync(path.join(this._photosDir(id), photoId + '.' + meta.ext)); } catch (_e) {}
        try { fs.unlinkSync(path.join(this._thumbsDir(id), photoId + '.jpg')); } catch (_e) {}
      }
      project.photos = project.photos.filter((p) => p.photoId !== photoId);
      clearPhotoRefs(project, photoId);
      return this._write(project);
    });
  }

  getPhotoPath(id, photoId, kind) {
    if (!safeId(id) || !safeId(photoId)) return null;
    const project = this._read(id);
    if (!project) return null;
    const meta = project.photos.find((p) => p.photoId === photoId);
    if (!meta) return null;
    if (kind === 'thumb') {
      const t = path.join(this._thumbsDir(id), photoId + '.jpg');
      if (fs.existsSync(t)) return t;
      // fall through to original when no thumb was produced
    }
    const o = path.join(this._photosDir(id), photoId + '.' + meta.ext);
    return fs.existsSync(o) ? o : null;
  }

  listProjectIds() {
    try {
      return fs.readdirSync(this.dataDir).filter((n) => safeId(n) && fs.existsSync(this._projFile(n)));
    } catch (_e) {
      return [];
    }
  }

  // Admin summary of every project (dev only; Supabase uses the edge fn).
  async listProjects() {
    return this.listProjectIds().map((id) => {
      let d = {};
      try { d = JSON.parse(fs.readFileSync(this._projFile(id), 'utf8')); } catch (_e) { d = {}; }
      const pi = d.propertyInfo || {};
      const agents = [d.agentInfo && d.agentInfo.name, d.agentInfo2 && d.agentInfo2.name].filter(Boolean);
      return {
        id,
        address: pi.address || '',
        city: pi.city || '',
        agents,
        theme: d.colorTheme || 'navy',
        confirmed: !!d.confirmed,
        createdAt: d.createdAt || null,
        updatedAt: d.updatedAt || null,
      };
    }).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }
}

module.exports = { LocalDiskStorage, _internals: { applyPatch, clearPhotoRefs, extFor, newId, safeId } };
