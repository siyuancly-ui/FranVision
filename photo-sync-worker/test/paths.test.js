import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRoot,
  parseFolderList,
  fileExt,
  isWebImage,
  isVideoFile,
  parseJobPath,
  isSyncCandidate,
  isVideoSyncCandidate,
  folderMatches,
  matchAncestorFolder,
  downloadCopyPath,
  downloadSubdirFor,
  parseAddressFromJobFolder,
  isTourLinkCandidate,
  imageContentType,
} from '../src/paths.js';

test('normalizeRoot', () => {
  assert.equal(normalizeRoot(''), '');
  assert.equal(normalizeRoot('/'), '');
  assert.equal(normalizeRoot('  '), '');
  assert.equal(normalizeRoot('/FranVision Jobs'), '/FranVision Jobs');
  assert.equal(normalizeRoot('/FranVision Jobs/'), '/FranVision Jobs');
  assert.equal(normalizeRoot('FranVision Jobs'), '/FranVision Jobs');
});

test('parseFolderList trims and drops empties', () => {
  assert.deepEqual(parseFolderList('MLS, Virtual Staging ,Floorplan,'), ['MLS', 'Virtual Staging', 'Floorplan']);
  assert.deepEqual(parseFolderList(''), []);
  assert.deepEqual(parseFolderList(undefined), []);
});

test('fileExt / isWebImage', () => {
  assert.equal(fileExt('DSC_0001.JPG'), 'jpg');
  assert.equal(fileExt('a.b.png'), 'png');
  assert.equal(fileExt('noext'), '');
  assert.ok(isWebImage('x.jpeg'));
  assert.ok(isWebImage('x.WEBP'));
  assert.ok(!isWebImage('x.cr2'));
  assert.ok(!isWebImage('x.pdf'));
});

test('imageContentType: maps a filename to its real Content-Type, defaults to jpeg', () => {
  assert.equal(imageContentType('main.png'), 'image/png');
  assert.equal(imageContentType('main.PNG'), 'image/png');
  assert.equal(imageContentType('a.jpg'), 'image/jpeg');
  assert.equal(imageContentType('a.jpeg'), 'image/jpeg');
  assert.equal(imageContentType('a.webp'), 'image/webp');
  assert.equal(imageContentType('a.pdf'), 'image/jpeg'); // unrecognized -> jpeg default
  assert.equal(imageContentType('noext'), 'image/jpeg');
});

test('parseJobPath at root', () => {
  const p = parseJobPath('/2026.09.07 12 Main St_Smith/MLS/DSC_0001.jpg', '');
  assert.equal(p.jobFolder, '2026.09.07 12 Main St_Smith');
  assert.equal(p.jobFolderPath, '/2026.09.07 12 Main St_Smith');
  assert.equal(p.subFolder, 'MLS');
  assert.equal(p.relPathFromJob, 'MLS/DSC_0001.jpg');
  assert.equal(p.filename, 'DSC_0001.jpg');
  assert.equal(p.depth, 3);
});

test('parseJobPath nested subdir', () => {
  const p = parseJobPath('/JobA/MLS/exports/web/IMG_1.png', '');
  assert.equal(p.subFolder, 'MLS');
  assert.equal(p.relPathFromJob, 'MLS/exports/web/IMG_1.png');
  assert.equal(p.filename, 'IMG_1.png');
});

test('parseJobPath with configured root', () => {
  const p = parseJobPath('/FranVision Jobs/JobA/MLS/x.jpg', '/FranVision Jobs');
  assert.equal(p.jobFolder, 'JobA');
  assert.equal(p.jobFolderPath, '/FranVision Jobs/JobA');
  assert.equal(p.subFolder, 'MLS');
  assert.equal(p.relPathFromJob, 'MLS/x.jpg');
});

test('parseJobPath rejects paths outside root', () => {
  assert.equal(parseJobPath('/Other/JobA/MLS/x.jpg', '/FranVision Jobs'), null);
  assert.equal(parseJobPath('relative/x.jpg', ''), null);
});

test('isSyncCandidate', () => {
  const cfg = { root: '', syncFolders: ['MLS', 'Virtual Staging', 'Floorplan', 'Local Report'] };
  assert.ok(isSyncCandidate('/JobA/MLS/x.jpg', cfg));
  assert.ok(isSyncCandidate('/JobA/mls/x.JPEG', cfg)); // case-insensitive folder + ext
  assert.ok(isSyncCandidate('/JobA/Virtual Staging/sub/y.png', cfg));
  assert.ok(!isSyncCandidate('/JobA/0 RAW/1 Raws/x.jpg', cfg)); // excluded folder
  assert.ok(!isSyncCandidate('/JobA/MLS/notes.pdf', cfg)); // not an image
  assert.ok(!isSyncCandidate('/JobA/MLS for download/x.jpg', cfg)); // loop guard: not in SYNC_FOLDERS
  assert.ok(!isSyncCandidate('/JobA/MLS', cfg)); // the folder itself, depth 2
});

test('isVideoFile', () => {
  assert.ok(isVideoFile('clip.mp4'));
  assert.ok(isVideoFile('clip.MOV'));
  assert.ok(isVideoFile('clip.m4v'));
  assert.ok(!isVideoFile('clip.jpg'));
  assert.ok(!isVideoFile('clip.avi'));
});

test('isVideoSyncCandidate', () => {
  const cfg = { root: '', videoSyncFolders: ['Video', 'VLOG'] };
  assert.ok(isVideoSyncCandidate('/JobA/Video/walkthrough.mp4', cfg));
  assert.ok(isVideoSyncCandidate('/JobA/vlog/day1.MOV', cfg)); // case-insensitive folder + ext
  assert.ok(!isVideoSyncCandidate('/JobA/MLS/x.jpg', cfg)); // not a video-sync folder
  assert.ok(!isVideoSyncCandidate('/JobA/Video/notes.pdf', cfg)); // not a video
  assert.ok(!isVideoSyncCandidate('/JobA/Video', cfg)); // the folder itself, depth 2
});

test('folderMatches', () => {
  assert.ok(folderMatches('mls', ['MLS']));
  assert.ok(folderMatches('MLS', ['mls']));
  assert.ok(!folderMatches('MLS2', ['MLS']));
});

test('downloadCopyPath forces .jpg', () => {
  assert.equal(
    downloadCopyPath('/JobA', 'MLS for download', 'DSC_0001.png'),
    '/JobA/MLS for download/DSC_0001.jpg',
  );
  assert.equal(
    downloadCopyPath('/FranVision Jobs/JobA', 'MLS for download', 'DSC_0001.jpg'),
    '/FranVision Jobs/JobA/MLS for download/DSC_0001.jpg',
  );
});

test('parseAddressFromJobFolder extracts the address between the date and the trailing _Client', () => {
  assert.equal(
    parseAddressFromJobFolder('2026.9.15 123 Delete Me Ave_Swan Si'),
    '123 Delete Me Ave',
  );
  assert.equal(
    parseAddressFromJobFolder('2025.9.26 23 Bonheur Rd_John Smith'),
    '23 Bonheur Rd',
  );
  assert.equal(parseAddressFromJobFolder('2026.1.2 1 A St_B'), '1 A St');
});

test('parseAddressFromJobFolder returns null for unrecognized shapes', () => {
  assert.equal(parseAddressFromJobFolder(''), null);
  assert.equal(parseAddressFromJobFolder(null), null);
  assert.equal(parseAddressFromJobFolder('Some Random Folder'), null); // no date prefix
  assert.equal(parseAddressFromJobFolder('2026.9.15 No Underscore Here'), null); // no _Client
  assert.equal(parseAddressFromJobFolder('2026.9.15 '), null); // empty after date, trimmed
});

test('parseJobPath: ancestors lists every directory between the job folder and the file', () => {
  assert.deepEqual(parseJobPath('/JobA/MLS/a.jpg', '').ancestors, ['MLS']);
  assert.deepEqual(parseJobPath('/JobA/HDR Photos/Drone Callout/a.jpg', '').ancestors, ['HDR Photos', 'Drone Callout']);
  assert.deepEqual(parseJobPath('/JobA/a.jpg', '').ancestors, []); // file directly in the job folder
});

test('matchAncestorFolder: matches the innermost (closest-to-file) ancestor first', () => {
  // "Drone Callout" nested inside "HDR Photos" -- confirmed 2026-09-16, both
  // names happen to be in the same list here; the more specific inner one
  // must win, not the outer "HDR Photos".
  const list = ['HDR Photos', 'Drone Callout', 'Local Report'];
  assert.equal(matchAncestorFolder(['HDR Photos', 'Drone Callout'], list), 'Drone Callout');
  assert.equal(matchAncestorFolder(['HDR Photos'], list), 'HDR Photos');
  // An unrecognized inner folder falls through to an outer recognized one --
  // matches today's existing behavior for e.g. a photographer's own
  // "HDR Photos/Retouched/x.jpg" organizing subfolder.
  assert.equal(matchAncestorFolder(['HDR Photos', 'Retouched'], list), 'HDR Photos');
  assert.equal(matchAncestorFolder(['Nothing Recognized'], list), null);
  assert.equal(matchAncestorFolder([], list), null);
});

test('isSyncCandidate / isVideoSyncCandidate recognize a folder nested at any depth', () => {
  const syncFolders = ['HDR Photos', 'Drone Callout'];
  assert.ok(isSyncCandidate('/JobA/HDR Photos/Drone Callout/a.jpg', { root: '', syncFolders }));
  assert.ok(isSyncCandidate('/JobA/Drone Callout/a.jpg', { root: '', syncFolders })); // also still works un-nested
  assert.ok(!isSyncCandidate('/JobA/Floorplan/a.jpg', { root: '', syncFolders }));

  const videoSyncFolders = ['Video'];
  assert.ok(isVideoSyncCandidate('/JobA/HDR Photos/Video/clip.mp4', { root: '', videoSyncFolders }));
});

test('isTourLinkCandidate: only matches the exact filename directly at the job folder root', () => {
  const cfg = { root: '', tourLinkFilename: 'Tour Link.txt' };
  assert.ok(isTourLinkCandidate('/JobA/Tour Link.txt', cfg));
  assert.ok(isTourLinkCandidate('/JobA/TOUR LINK.TXT', cfg)); // case-insensitive
  assert.ok(!isTourLinkCandidate('/JobA/HDR Photos/Tour Link.txt', cfg)); // nested -- not the job root
  assert.ok(!isTourLinkCandidate('/JobA/Notes.txt', cfg)); // different filename
  assert.ok(!isTourLinkCandidate('/Tour Link.txt', cfg)); // no job folder segment at all
});

test('downloadCopyPath: optional sub-directory mirrors a nested source folder', () => {
  assert.equal(downloadCopyPath('/JobA', 'MLS for download', 'c.png', 'Callout'), '/JobA/MLS for download/Callout/c.jpg');
});

test('downloadSubdirFor: HDR Photos/MLS files -> flat; Callout nested under them -> Callout; Callout directly under the job folder -> none', () => {
  const cfg = { downloadSetFolders: ['MLS', 'HDR Photos'], downloadNestedFolders: ['Callout'] };
  const it = (subFolder, relPathFromJob) => ({ subFolder, relPathFromJob });
  assert.equal(downloadSubdirFor(it('HDR Photos', 'HDR Photos/a.jpg'), cfg), '');
  assert.equal(downloadSubdirFor(it('Callout', 'HDR Photos/Callout/a.jpg'), cfg), 'Callout');
  assert.equal(downloadSubdirFor(it('Callout', 'MLS/callout/a.jpg'), cfg), 'callout');
  assert.equal(downloadSubdirFor(it('Callout', 'Callout/a.jpg'), cfg), null);
  assert.equal(downloadSubdirFor(it('Floorplan', 'Floorplan/a.jpg'), cfg), null);
  assert.equal(downloadSubdirFor(it('Callout', 'HDR Photos/Callout/a.jpg'), { downloadSetFolders: ['HDR Photos'] }), null);
});

test('isSyncCandidate: excludeFolders rejects any path with that folder as an ancestor (derived copies), keeps real Callout photos', () => {
  const opts = { root: '', syncFolders: ['HDR Photos', 'Callout'], excludeFolders: ['MLS for download'] };
  assert.equal(isSyncCandidate('/J/HDR Photos/Callout/x.jpg', opts), true);
  assert.equal(isSyncCandidate('/J/MLS for download/Callout/x.jpg', opts), false);
  assert.equal(isSyncCandidate('/J/MLS for download/x.jpg', opts), false);
  assert.equal(isSyncCandidate('/J/deep/MLS for download/HDR Photos/x.jpg', opts), false);
  // without excludeFolders the old (buggy) behaviour is what you get -- callers must pass it
  assert.equal(isSyncCandidate('/J/MLS for download/Callout/x.jpg', { root: '', syncFolders: ['Callout'] }), true);
});
