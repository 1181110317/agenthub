const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const files = [
  'server.js',
  'public/app.js',
  ...fs.readdirSync(path.join(root, 'lib')).filter(name => name.endsWith('.js')).map(name => path.join('lib', name)),
];

let failed = false;
for (const relative of files) {
  const file = path.join(root, relative);
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`\n[syntax] ${relative}\n${result.stderr || result.stdout || 'syntax check failed'}\n`);
  }
}

if (failed) process.exit(1);
console.log(`[syntax] checked ${files.length} JavaScript files`);
