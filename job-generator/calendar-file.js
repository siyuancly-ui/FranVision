// FranVision Job Generator -- auto-generated .ics calendar file for the shoot.
//
// The notes textarea + image upload right after Service Selection exist
// for exactly ONE reason: feeding this calendar event. They are NOT
// mirrored into job.json, Job Info.txt, or Dropbox in any form.
//
// The images are not reference/inspiration photos -- typically a
// lockbox/gate code or a screenshot of instructions the listing agent
// sent (sometimes it's easier to paste a screenshot than retype it).
//
// What gets written, once per job:
//   <job folder>/Shoot Schedule.ics   -- the calendar event, self-contained
//
// The images are NOT embedded any more (2026-09-21). They used to be base64
// ATTACH properties, which only Apple Calendar and classic Outlook desktop
// showed -- Google Calendar and new/web Outlook ignore binary ATTACH. Now
// server.js uploads each image to the job server's public storage bucket
// (job-backend.js#uploadImage, supabase/storage.sql) under an unguessable
// path, and this file writes the resulting LINKS into the event DESCRIPTION
// (after the notes). Every calendar app shows and linkifies a URL in the
// description, and it is a plain link so nothing is lost when the .ics is
// re-imported. readImagesFromIcsFile() still reads the OLD base64 ATTACH form
// so drafts saved before this change keep their images.
//
// `Shoot Schedule.ics` is LOCAL-ONLY (file-sync.js's LOCAL_ONLY_FILENAMES)
// -- it never reaches Dropbox via Push, same guarantee job.json/Job
// Info.txt have. The user imports it into their calendar by hand; this is
// a passive file, not an active calendar-API integration.
//
// Shoot Time is optional (the Shoot Date field is date-only). Blank Shoot
// Time -> no calendar event exists, so nothing is written and any
// notes/images collected are simply not persisted anywhere.
//
// Pre-2026-09-10 this wrote a "Shoot Info" subfolder holding the .ics plus
// loose image files. writeCalendarFile() cleans that folder up when it
// runs, and readExistingImages() still reads it (once) so an old job's
// images survive its first update.

const fs = require('fs');
const path = require('path');
const sanitize = require('./sanitize.js');
const validate = require('./validate.js');

const ICS_FILENAME = 'Shoot Schedule.ics';
const LEGACY_FOLDER_NAME = 'Shoot Info';
const DEFAULT_DURATION_MINUTES = 120; // 2 hours -- typical real-estate shoot length

const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB per image -- lockbox codes/screenshots, not deliverable RAW files
const MAX_TOTAL_BYTES = 60 * 1024 * 1024; // 60MB combined -- bounds the worst case (see server.js's request body cap)
const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif']);
const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
};

function fileExt(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

// Pure validation -- checked before touching disk so a bad request fails
// with one clear error instead of partially writing files. Returns an
// array of human-readable problem strings; empty means valid.
function validateImages(images) {
  const problems = [];
  if (!images) return problems;
  if (images.length > MAX_IMAGES) {
    problems.push('Too many images (' + images.length + ') -- max ' + MAX_IMAGES + '.');
  }
  images.forEach((img, i) => {
    const label = img && img.filename ? img.filename : 'image ' + (i + 1);
    const ext = fileExt(img && img.filename);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      problems.push(label + ': unsupported file type (.' + (ext || '?') + ').');
    }
    if (img && img.url) return; // already uploaded -- nothing to size-check
    const base64 = (img && img.dataBase64) || '';
    // Base64 is ~4/3 the size of the original bytes -- estimate back.
    const approxBytes = Math.floor(base64.length * 3 / 4);
    if (approxBytes > MAX_IMAGE_BYTES) {
      problems.push(label + ': too large (' + (approxBytes / (1024 * 1024)).toFixed(1) + 'MB, max ' + (MAX_IMAGE_BYTES / (1024 * 1024)) + 'MB).');
    }
  });

  const totalApproxBytes = images.reduce((sum, img) => sum + Math.floor(((img && img.dataBase64) || '').length * 3 / 4), 0);
  if (totalApproxBytes > MAX_TOTAL_BYTES) {
    problems.push('Images total ' + (totalApproxBytes / (1024 * 1024)).toFixed(1) + 'MB, max ' + (MAX_TOTAL_BYTES / (1024 * 1024)) + 'MB combined.');
  }

  return problems;
}

// RFC 5545 TEXT escaping: backslash, semicolon, comma, and newlines.
function icsEscape(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}

// RFC 5545 param value: double-quote it (and drop any embedded quotes,
// which aren't allowed inside a quoted param value anyway).
function icsParamQuote(value) {
  return '"' + String(value).replace(/"/g, '') + '"';
}

// RFC 5545 line folding: continuation lines are prefixed with a single
// space. Folds on a conservative 70-character chunk -- good enough for
// short human text AND for the long base64 ATTACH payloads.
function foldLine(line) {
  const CHUNK = 70;
  if (line.length <= CHUNK) return line;
  let result = line.slice(0, CHUNK);
  let rest = line.slice(CHUNK);
  while (rest.length) {
    result += '\r\n ' + rest.slice(0, CHUNK - 1);
    rest = rest.slice(CHUNK - 1);
  }
  return result;
}

// Undo RFC 5545 line folding: CRLF (or LF) followed by a single space or
// tab is a continuation, not a real line break.
function unfoldIcs(raw) {
  return String(raw).replace(/\r?\n[ \t]/g, '');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Parses 'yyyy/mm/dd' + 'HH:MM' as LOCAL wall-clock time on THIS machine
// (the one running job-generator, i.e. wherever the shoot actually is) --
// returns a real Date. new Date(y, mo, d, hh, mm) always uses the host
// OS's configured timezone (DST-correct for that exact date), so this
// needs no manual timezone table.
function parseLocalShootDateTime(shootDate, shootTime) {
  const [y, mo, d] = shootDate.split('/').map(Number);
  const [hh, mm] = shootTime.split(':').map(Number);
  return new Date(y, mo - 1, d, hh, mm, 0);
}

// Formats a Date as a real UTC iCalendar DATE-TIME ("YYYYMMDDTHHMMSSZ").
//
// Earlier this wrote a "floating" local time instead (no Z, no TZID) on
// the theory that the user imports it by hand on their own machine, so
// ambiguity wouldn't matter. Found wrong in real use (2026-09): the
// calendar app used to open the .ics on Windows did NOT treat the
// floating time as "local, whatever that means to you" -- it showed a
// time that didn't match what was typed. Floating-DATE-TIME handling is
// inconsistent across real calendar clients; a real UTC instant has no
// such ambiguity anywhere -- every client converts it to the viewer's own
// local time correctly, and since the studio's team views these on
// machines in the same timezone the job was created in, the displayed
// time matches what was typed.
function formatUtcStamp(date) {
  return date.getUTCFullYear() + pad2(date.getUTCMonth() + 1) + pad2(date.getUTCDate()) + 'T' +
    pad2(date.getUTCHours()) + pad2(date.getUTCMinutes()) + pad2(date.getUTCSeconds()) + 'Z';
}

// ---- Calendar event title (SUMMARY), 2026-09-16 -- encodes the ordered
// service package + client name + photographer abbreviation, e.g.
// "HDR P+V+D_Paul_jo" for Luxury Photos + Walkthrough Video + Drone,
// client Paul, shot by Johnson. Replaces the old "Photo Shoot -- <client>"
// title. Code order is fixed (confirmed with the user 2026-09-16, matches
// how services are normally listed): photography, video, drone, 3D tour,
// floor plan, feature sheets -- a service not ordered is skipped
// entirely rather than leaving an empty "+" gap.
const PACKAGE_CODES = {
  photographyStandard: 'P',
  photographyLuxury: 'HDR P',
  walkthroughVideo: 'V',
  vlogVideo: 'Vlog',
  drone: 'D',
  threeDTour: '3D',
  floorplan: 'fl',
  featureSheets: 'FS',
};

// Fixed abbreviations for the studio's regular photographers (matched
// case-insensitively against the free-typed Photographer Name field).
// Anyone else gets their name's first two letters instead (e.g. "Mike"
// -> "Mi") so a new/guest photographer's job still gets a sensible,
// distinct title rather than a silently-dropped or generic one.
const KNOWN_PHOTOGRAPHER_CODES = {
  franky: 'F',
  johnson: 'jo',
  jason: 'j',
  elsa: 'E',
};
// Photographer Name is optional (job-generator/CLAUDE.md) -- a blank one
// gets this literal placeholder rather than omitting the segment, so the
// title's shape ("package_client_photographer") stays consistent and a
// blank credit doesn't read as a formatting glitch.
const UNKNOWN_PHOTOGRAPHER_PLACEHOLDER = '？';

function photographerCode(photographerName) {
  const trimmed = String(photographerName || '').trim();
  if (!trimmed) return UNKNOWN_PHOTOGRAPHER_PLACEHOLDER;
  const known = KNOWN_PHOTOGRAPHER_CODES[trimmed.toLowerCase()];
  if (known) return known;
  const first2 = trimmed.slice(0, 2);
  return first2.length < 2 ? first2.toUpperCase() : first2[0].toUpperCase() + first2[1].toLowerCase();
}

function buildPackageCode(order) {
  const addons = (order && order.addons) || {};
  const codes = [(order && order.photography === 'luxury') ? PACKAGE_CODES.photographyLuxury : PACKAGE_CODES.photographyStandard];
  // Walkthrough and Vlog Video are never ordered together on one job --
  // same assumption delivery-email.js's getDeliverableLines() makes.
  if (addons.walkthrough_video) codes.push(PACKAGE_CODES.walkthroughVideo);
  else if (addons.vlog_video) codes.push(PACKAGE_CODES.vlogVideo);
  if (addons.drone_photos) codes.push(PACKAGE_CODES.drone);
  if (addons.three_d_tour) codes.push(PACKAGE_CODES.threeDTour);
  if (addons.floor_plan || addons.site_plan) codes.push(PACKAGE_CODES.floorplan);
  if (addons.feature_sheets) codes.push(PACKAGE_CODES.featureSheets);
  return codes.join('+');
}

function buildEventTitle({ order, clientName, photographerName }) {
  return buildPackageCode(order) + '_' + (clientName || '') + '_' + photographerCode(photographerName);
}

// ---- Draft calendar file name (2026-09-19) ---------------------------------
// Save as Draft no longer creates a job folder -- it drops ONE .ics into the
// Job Root Folder itself, so the file needs a name that tells drafts apart:
//   <event title> <shoot date> <short address>.ics
//   e.g.  S+V_Jane_F 2026.9.25 12 Cozens.ics
// The event title is buildEventTitle()'s existing package_client_photographer
// rule; the date uses the folder-name style (no leading zeros); the short
// address is house number + street NAME only (street type / trailing
// direction dropped) so it stays short. The date + address are what keep two
// drafts for the same client + package apart.
const STREET_TYPES = new Set([
  'st', 'street', 'ave', 'avenue', 'av', 'rd', 'road', 'dr', 'drive', 'blvd', 'boulevard', 'ct', 'crt', 'court',
  'cres', 'crescent', 'ln', 'lane', 'way', 'pl', 'place', 'terr', 'terrace', 'cir', 'circle', 'hwy', 'pkwy',
  'parkway', 'trl', 'trail', 'gate', 'gt', 'sq', 'square', 'common', 'cmn', 'grv', 'grove', 'hts', 'heights',
  'path', 'walk', 'line', 'row', 'mews', 'gdns', 'gardens', 'crossing', 'xing',
]);
const DIRECTIONS = new Set(['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']);

// "12 Cozens Dr, Markham" -> "12 Cozens"; "394 Centre St E, Richmond Hill" ->
// "394 Centre". Never strips the last remaining word (so "12 Park St" keeps
// "Park", and a bare "Main" stays "Main").
function shortAddress(address) {
  const firstPart = String(address || '').split(',')[0].trim();
  const tokens = firstPart.split(/\s+/).filter(Boolean);
  const bare = (t) => t.replace(/\./g, '').toLowerCase();
  while (tokens.length > 2 && DIRECTIONS.has(bare(tokens[tokens.length - 1]))) tokens.pop();
  if (tokens.length > 2 && STREET_TYPES.has(bare(tokens[tokens.length - 1]))) tokens.pop();
  return tokens.join(' ');
}

function buildDraftCalendarFilename({ order, clientName, photographerName, shootDate, address }) {
  const parts = [
    buildEventTitle({ order, clientName, photographerName }),
    sanitize.formatDateForFolderName(shootDate),
    shortAddress(address),
  ].filter((x) => x && String(x).trim());
  return sanitize.sanitizeSegment(parts.join(' '), 'Shoot Schedule') + '.ics';
}

// `images` is [{ filename, url }] (already uploaded) -- listed as links in
// DESCRIPTION after the notes; there is no ATTACH.
// Notes, then (if any) an "Images" list: filename line + bare URL line each, so
// every calendar app auto-links the URL.
function buildDescription(notes, images) {
  const parts = [];
  if (notes && String(notes).trim()) parts.push(String(notes).trim());
  const withUrl = (images || []).filter((img) => img && img.url);
  if (withUrl.length) {
    parts.push('图片 Images:\n' + withUrl.map((img, i) => (i + 1) + '. ' + img.filename + '\n' + img.url).join('\n'));
  }
  return parts.join('\n\n');
}

function buildIcs({ jobId, clientName, address, shootDate, shootTime, notes, images, durationMinutes, order, photographerName }) {
  const startDt = parseLocalShootDateTime(shootDate, shootTime);
  // Real elapsed-time addition (not wall-clock field arithmetic) -- exact
  // regardless of any DST transition inside the shoot window.
  const endDt = new Date(startDt.getTime() + (durationMinutes || DEFAULT_DURATION_MINUTES) * 60000);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FranVision//Job Generator//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:' + jobId + '@franvision.local',
    'DTSTAMP:' + formatUtcStamp(new Date()),
    'DTSTART:' + formatUtcStamp(startDt),
    'DTEND:' + formatUtcStamp(endDt),
    'SUMMARY:' + icsEscape(buildEventTitle({ order, clientName, photographerName })),
    'LOCATION:' + icsEscape(address),
  ];
  const description = buildDescription(notes, images);
  if (description) lines.push('DESCRIPTION:' + icsEscape(description));
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');

  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// Writes <jobFolder>/Shoot Schedule.ics (images as links in DESCRIPTION). Returns null when there's no Shoot Time -- with no time
// there's no calendar event, and this data has no other purpose, so
// nothing is written. Throws on an invalid time, a missing/invalid Shoot
// Date (needed for DTSTART -- a caller like draft-store.js may keep Shoot
// Date blank on purpose but can't ask for a calendar file without one),
// or invalid image(s). Also removes any legacy "Shoot Info" subfolder.
//
// `writeOpts.filename` (default 'Shoot Schedule.ics') lets a caller write a
// differently-named file into the folder -- used for the draft calendar file
// dropped straight into the Job Root Folder (see buildDraftCalendarFilename).
function writeCalendarFile(jobFolderAbsolutePath, { jobId, clientName, address, shootDate, shootTime, notes, images, durationMinutes, order, photographerName }, writeOpts) {
  const filename = (writeOpts && writeOpts.filename) || ICS_FILENAME;
  if (!shootTime || !String(shootTime).trim()) return null;
  if (!validate.isValidShootTime(shootTime)) {
    throw new Error('Shoot Time must be in HH:MM 24-hour format.');
  }
  if (!validate.isValidShootDate(shootDate)) {
    throw new Error('Shoot Date must be set (valid yyyy/mm/dd) before a calendar file can be generated -- leave Shoot Time blank if the date isn\'t decided yet.');
  }

  const problems = validateImages(images);
  if (problems.length) {
    throw new Error('Invalid image(s): ' + problems.join(' '));
  }

  fs.mkdirSync(jobFolderAbsolutePath, { recursive: true });

  // Every image must already be uploaded (server.js does that first).
  for (const img of images || []) {
    if (!img || !img.url) throw new Error('Invalid image(s): ' + ((img && img.filename) || 'an image') + ' has not been uploaded (no link).');
  }

  // De-dupe filenames so the listed names are unique.
  const attachedImages = [];
  const usedNames = new Set();
  const normImages = (images || []).map((img, i) => {
    const name = sanitize.sanitizeSegment(img.filename, 'image-' + (i + 1) + '.jpg');
    let candidate = name;
    let suffix = 1;
    while (usedNames.has(candidate.toLowerCase())) {
      const ext = fileExt(name);
      const base = ext ? name.slice(0, -(ext.length + 1)) : name;
      candidate = base + ' (' + (++suffix) + ')' + (ext ? '.' + ext : '');
    }
    usedNames.add(candidate.toLowerCase());
    attachedImages.push(candidate);
    return { filename: candidate, url: img.url };
  });

  const icsContent = buildIcs({ jobId, clientName, address, shootDate, shootTime, notes, images: normImages, durationMinutes, order, photographerName });
  const icsPath = path.join(jobFolderAbsolutePath, filename);
  fs.writeFileSync(icsPath, icsContent, 'utf8');

  if (filename === ICS_FILENAME) {
    fs.rmSync(path.join(jobFolderAbsolutePath, LEGACY_FOLDER_NAME), { recursive: true, force: true });
  }

  return { icsPath, icsFilename: filename, attachedImages };
}

// Reads a job's already-attached images back as [{ filename, dataBase64 }]
// -- from the base64 ATTACH properties of <jobFolder>/Shoot Schedule.ics,
// AND (legacy, merged in) from loose files in a <jobFolder>/Shoot Info/
// folder. Used to re-show a draft's images (draft-store.js) and to
// PRESERVE a job's images across an update (server.js), since the update
// form has no "load existing job" step.
// The ATTACH images of ONE .ics file as [{ filename, dataBase64 }]; [] if the
// file doesn't exist. (readExistingImages() below adds the legacy folder.)
function readImagesFromIcsFile(icsPath) {
  const byName = new Map();
  try {
    const unfolded = unfoldIcs(fs.readFileSync(icsPath, 'utf8'));
    for (const line of unfolded.split(/\r?\n/)) {
      if (!/^ATTACH[;:]/.test(line)) continue;
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const params = line.slice(0, colon);
      const data = line.slice(colon + 1);
      const m = params.match(/X-(?:APPLE-)?FILENAME=(?:"([^"]*)"|([^;:]+))/i);
      const filename = (m && (m[1] || m[2])) || ('attachment-' + (byName.size + 1));
      byName.set(filename, { filename, dataBase64: data });
    }
  } catch (err) { /* no .ics yet */ }
  return Array.from(byName.values());
}

function readExistingImages(jobFolderAbsolutePath) {
  const byName = new Map();
  for (const img of readImagesFromIcsFile(path.join(jobFolderAbsolutePath, ICS_FILENAME))) byName.set(img.filename, img);

  try {
    const dir = path.join(jobFolderAbsolutePath, LEGACY_FOLDER_NAME);
    for (const name of fs.readdirSync(dir)) {
      if (name === ICS_FILENAME || byName.has(name)) continue;
      byName.set(name, { filename: name, dataBase64: fs.readFileSync(path.join(dir, name)).toString('base64') });
    }
  } catch (err) { /* no legacy folder */ }

  return Array.from(byName.values());
}

// Merges preserved images with freshly-uploaded ones for the update
// path: a fresh upload with the same filename WINS (replaces the old
// one); every other preserved image is kept. Order: preserved-not-
// -replaced first, then all fresh.
function mergeImages(preserved, fresh) {
  const freshNames = new Set((fresh || []).map((img) => String(img.filename).toLowerCase()));
  const keptPreserved = (preserved || []).filter((img) => !freshNames.has(String(img.filename).toLowerCase()));
  return keptPreserved.concat(fresh || []);
}

module.exports = {
  ICS_FILENAME,
  LEGACY_FOLDER_NAME,
  DEFAULT_DURATION_MINUTES,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  ALLOWED_EXTENSIONS,
  EXT_MIME,
  validateImages,
  buildIcs,
  buildDescription,
  writeCalendarFile,
  readExistingImages,
  readImagesFromIcsFile,
  shortAddress,
  buildDraftCalendarFilename,
  mergeImages,
  buildEventTitle,
  buildPackageCode,
  photographerCode,
};
