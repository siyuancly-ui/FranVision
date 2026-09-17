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
// The images are embedded IN that .ics as standard base64 ATTACH
// properties (`ATTACH;FMTTYPE=<mime>;ENCODING=BASE64;VALUE=BINARY;
// X-APPLE-FILENAME="…";X-FILENAME="…":<base64>`). This is a plain
// RFC 5545 binary attachment -- only the filename hint is client-
// flavoured (X-APPLE-FILENAME for Apple Calendar, X-FILENAME for others
// incl. classic desktop Outlook). Apple Calendar and classic Outlook
// desktop attach it to the event on import; Google Calendar and "new"/
// web Outlook ignore binary ATTACH entirely (their attachments are a
// Drive/OneDrive integration, not an .ics feature). There are no loose
// image files on disk any more.
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

// `images` is [{ filename, dataBase64 }] -- each becomes a base64 ATTACH
// on the VEVENT. DESCRIPTION carries just the notes text.
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
  if (notes && String(notes).trim()) {
    lines.push('DESCRIPTION:' + icsEscape(String(notes).trim()));
  }
  for (const img of images || []) {
    const mime = EXT_MIME[fileExt(img.filename)] || 'application/octet-stream';
    const nameParam = icsParamQuote(img.filename);
    lines.push(
      'ATTACH;FMTTYPE=' + mime + ';ENCODING=BASE64;VALUE=BINARY;X-APPLE-FILENAME=' +
      nameParam + ';X-FILENAME=' + nameParam + ':' + img.dataBase64
    );
  }
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');

  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// Writes <jobFolder>/Shoot Schedule.ics (images embedded as base64
// ATTACH). Returns null when there's no Shoot Time -- with no time
// there's no calendar event, and this data has no other purpose, so
// nothing is written. Throws on an invalid time, a missing/invalid Shoot
// Date (needed for DTSTART -- a caller like draft-store.js may keep Shoot
// Date blank on purpose but can't ask for a calendar file without one),
// or invalid image(s). Also removes any legacy "Shoot Info" subfolder.
function writeCalendarFile(jobFolderAbsolutePath, { jobId, clientName, address, shootDate, shootTime, notes, images, durationMinutes, order, photographerName }) {
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

  // De-dupe filenames so each ATTACH's X-APPLE-FILENAME is unique.
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
    return { filename: candidate, dataBase64: img.dataBase64 };
  });

  const icsContent = buildIcs({ jobId, clientName, address, shootDate, shootTime, notes, images: normImages, durationMinutes, order, photographerName });
  const icsPath = path.join(jobFolderAbsolutePath, ICS_FILENAME);
  fs.writeFileSync(icsPath, icsContent, 'utf8');

  fs.rmSync(path.join(jobFolderAbsolutePath, LEGACY_FOLDER_NAME), { recursive: true, force: true });

  return { icsPath, icsFilename: ICS_FILENAME, attachedImages };
}

// Reads a job's already-attached images back as [{ filename, dataBase64 }]
// -- from the base64 ATTACH properties of <jobFolder>/Shoot Schedule.ics,
// AND (legacy, merged in) from loose files in a <jobFolder>/Shoot Info/
// folder. Used to re-show a draft's images (draft-store.js) and to
// PRESERVE a job's images across an update (server.js), since the update
// form has no "load existing job" step.
function readExistingImages(jobFolderAbsolutePath) {
  const byName = new Map();

  try {
    const unfolded = unfoldIcs(fs.readFileSync(path.join(jobFolderAbsolutePath, ICS_FILENAME), 'utf8'));
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
  validateImages,
  buildIcs,
  writeCalendarFile,
  readExistingImages,
  mergeImages,
  buildEventTitle,
  buildPackageCode,
  photographerCode,
};
