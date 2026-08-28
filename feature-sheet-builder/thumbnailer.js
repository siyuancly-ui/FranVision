/*
 * thumbnailer.js -- read image dimensions + make a small preview JPEG.
 *
 * Uses macOS `sips` (shell-out, zero npm deps -- same approach as
 * job-generator/server.js calling `osascript`). On a non-macOS host, or
 * if `sips` fails, it degrades gracefully: no thumbnail is written
 * (callers fall back to the original) and dimensions come back as 0,
 * which crop-math.js treats as "unknown" without breaking layout.
 */

const { execFile } = require('child_process');
const fs = require('fs');

const THUMB_MAX_EDGE = 480; // px, long edge

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: String(stderr || '') }));
      resolve(String(stdout || ''));
    });
  });
}

/** Return { width, height } in pixels, or { width: 0, height: 0 } if unknown. */
async function readDimensions(filePath) {
  try {
    const out = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath]);
    const w = /pixelWidth:\s*(\d+)/.exec(out);
    const h = /pixelHeight:\s*(\d+)/.exec(out);
    return { width: w ? parseInt(w[1], 10) : 0, height: h ? parseInt(h[1], 10) : 0 };
  } catch (_e) {
    return { width: 0, height: 0 };
  }
}

/**
 * Write a downscaled JPEG preview of `srcPath` to `thumbPath`.
 * Returns true on success, false if it degraded (no file written).
 */
async function makeThumbnail(srcPath, thumbPath) {
  try {
    await run('sips', ['-Z', String(THUMB_MAX_EDGE), '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', srcPath, '--out', thumbPath]);
    return fs.existsSync(thumbPath);
  } catch (_e) {
    return false;
  }
}

/** Convenience: dimensions + thumbnail in one call. */
async function process(srcPath, thumbPath) {
  const [dims, thumbOk] = await Promise.all([
    readDimensions(srcPath),
    makeThumbnail(srcPath, thumbPath),
  ]);
  return { width: dims.width, height: dims.height, thumbOk };
}

module.exports = { THUMB_MAX_EDGE, readDimensions, makeThumbnail, process };
