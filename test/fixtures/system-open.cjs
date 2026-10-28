// Capture only launcher dispatches in the isolated filesystem test. No native
// window, shell or editor is opened. All other child processes remain real.
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const originalSpawn = cp.spawn, originalExec = cp.execFile;
const log = record => fs.appendFileSync(process.env.AH_LAUNCH_LOG, JSON.stringify(record) + '\n');
cp.spawn = function(bin, args, options) {
  const name = path.basename(bin).toLowerCase();
  if (!options?.detached || !['explorer.exe','code.exe','code - insiders.exe','code','open','xdg-open','x-terminal-emulator'].includes(name)) return originalSpawn.apply(this, arguments);
  log({ type:'spawn', bin, args, options });
  const child = new EventEmitter(); child.unref = () => {}; child.kill = () => {};
  setTimeout(() => {
    if (args.some(arg => String(arg).includes('fail-launch'))) child.emit('error', new Error('fixture launcher unavailable'));
    else child.emit('spawn');
  }, 30);
  return child;
};
cp.execFile = function(bin, args, options, callback) {
  const index = args.indexOf('-EncodedCommand');
  const script = index >= 0 ? Buffer.from(args[index+1], 'base64').toString('utf16le') : '';
  if (path.basename(bin).toLowerCase() !== 'powershell.exe' || !script.includes('Start-Process')) return originalExec.apply(this, arguments);
  log({ type:'exec', bin, args, options, script });
  setTimeout(() => script.includes('fail-launch') ? callback(new Error('fixture failed'), '', 'fixture launcher unavailable') : callback(null, '', ''), 30);
  return new EventEmitter();
};
