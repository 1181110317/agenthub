// Open a validated local path without treating its characters as shell syntax.
// The caller owns workspace/path validation. Dispatch errors must reach the UI.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    let child, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => { try { child?.kill(); } catch {} finish(new Error('启动超时：' + command)); }, 10000);
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('spawn', () => { child.unref(); finish(); });
      child.on('error', error => {
        if (!settled) finish(error);
        else console.error('[fs] 打开失败：' + error.message);
      });
    } catch (error) { finish(error); }
  });
}
const literal = value => "'" + String(value).replace(/'/g, "''") + "'";
function startWindows(script) {
  // EncodedCommand formats uncaught PowerShell errors as CLIXML. Emit only the
  // readable exception message in UTF-8 so it can be shown directly in the UI.
  const source = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; try { " + script + " } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }";
  const encoded = Buffer.from(source, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(String(stderr || (error.code === 'ENOENT' ? '未找到 Windows PowerShell，请检查系统安装' : error.killed ? '系统应用启动超时' : '无法启动系统应用，请检查文件关联或应用安装')).trim().slice(0, 1200)));
        else resolve();
      });
  });
}
async function windowsCodeExecutable() {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = dirs.flatMap(dir => [path.join(dir, 'Code.exe'), path.join(dir, 'Code - Insiders.exe'),
    path.resolve(dir, '..', 'Code.exe'), path.resolve(dir, '..', 'Code - Insiders.exe')]);
  for (const dir of [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'), process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    candidates.push(path.join(dir, 'Microsoft VS Code', 'Code.exe'), path.join(dir, 'Microsoft VS Code Insiders', 'Code - Insiders.exe'));
  }
  for (const candidate of candidates) { try { if ((await fs.promises.stat(candidate)).isFile()) return candidate; } catch {} }
  throw new Error('未找到 VS Code 客户端，请安装或把客户端的 bin 目录加入 PATH');
}
async function openLocal(target, mode) {
  const platform = process.platform;
  if (mode === 'reveal') {
    if (platform === 'win32') return spawnDetached('explorer.exe', ['/select,' + path.win32.normalize(target)]);
    return spawnDetached(platform === 'darwin' ? 'open' : 'xdg-open', platform === 'darwin' ? ['-R', target] : [path.dirname(target)]);
  }
  if (mode === 'vscode') return spawnDetached(platform === 'win32' ? await windowsCodeExecutable() : 'code', [target]);
  if (mode === 'terminal') {
    const dir = (await fs.promises.stat(target)).isDirectory() ? target : path.dirname(target);
    if (platform === 'win32') return startWindows('Start-Process -FilePath ' + literal(process.env.ComSpec || 'cmd.exe') + ' -WorkingDirectory ' + literal(dir) + " -ArgumentList '/K'");
    return spawnDetached(platform === 'darwin' ? 'open' : 'x-terminal-emulator', platform === 'darwin' ? ['-a', 'Terminal', dir] : ['--working-directory', dir]);
  }
  if (platform === 'win32') return startWindows('Start-Process -FilePath ' + literal(target));
  return spawnDetached(platform === 'darwin' ? 'open' : 'xdg-open', [target]);
}
module.exports = { openLocal };
