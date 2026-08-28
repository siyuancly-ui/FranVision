/*
 * prepare-static.js -- copy the files the Node server would otherwise
 * serve dynamically (/shared/* and /template-assets/*) into public/ so the
 * frontend can be hosted as pure static files (Cloudflare Pages, Netlify).
 *
 * Cloudflare Pages build settings:
 *   Build command:            node feature-sheet-builder/prepare-static.js
 *   Build output directory:   feature-sheet-builder/public
 *
 * The copied paths are git-ignored (see .gitignore) -- they are generated.
 * Local dev (`node server.js`) does NOT need this; the server serves the
 * originals at the same URLs.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log('  ' + path.relative(ROOT, src) + '  ->  ' + path.relative(ROOT, dest));
}

console.log('prepare-static: copying shared modules + template assets into public/');

// Shared modules loaded by index.html as /shared/*.js
copy(path.join(ROOT, 'crop-math.js'), path.join(PUB, 'shared', 'crop-math.js'));
copy(path.join(ROOT, 'templates', 'registry.js'), path.join(PUB, 'shared', 'registry.js'));
copy(path.join(ROOT, 'templates', 'jason-fs-v1', 'template-config.js'), path.join(PUB, 'shared', 'template-config.js'));

// Template assets referenced as /template-assets/<templateId>/...
const tplDir = path.join(ROOT, 'templates');
for (const tpl of fs.readdirSync(tplDir)) {
  const assetsDir = path.join(tplDir, tpl, 'assets');
  if (!fs.existsSync(assetsDir)) continue;
  for (const f of fs.readdirSync(assetsDir)) {
    copy(path.join(assetsDir, f), path.join(PUB, 'template-assets', tpl, 'assets', f));
  }
}

console.log('prepare-static: done');
