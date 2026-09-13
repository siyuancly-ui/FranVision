// Cross-platform test runner -- runs every *.test.js in this folder with
// the same Node that launched this script. Used by `npm test` so it works
// on Windows too (the old `for f in *.test.js` script was bash-only). Any
// individual test file can still be run directly: `node <name>.test.js`.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
let failed = 0;

for (const file of files) {
  const res = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  if (res.status !== 0) failed++;
}

console.log('\n' + (failed
  ? failed + ' of ' + files.length + ' test file(s) FAILED'
  : 'all ' + files.length + ' test files passed'));
process.exit(failed ? 1 : 0);
