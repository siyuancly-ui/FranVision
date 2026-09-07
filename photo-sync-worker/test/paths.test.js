import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRoot,
  parseFolderList,
  fileExt,
  isWebImage,
  parseJobPath,
  isSyncCandidate,
  folderMatches,
  downloadCopyPath,
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
