'use strict';
// SFTP keeps ordinary file browsing/editing usable without Node or Git on the
// target. Git operations retain the target worker and its login environment.
const path = require('path').posix, crypto = require('crypto');
const { fail } = require('./workflow-store');
const MAX = 2 * 1024 * 1024;
async function execute(cfg, session, op, body = {}) {
  return require('./ssh').withSftp(cfg, async sftp => {
    const call = (method, ...args) => new Promise((resolve, reject) => sftp[method](...args, (error, value) => error ? reject(error) : resolve(value)));
    const raw = String(session.cwd || '').replace(/\\/g, '/');
    const home = await call('realpath', '.');
    const root = (await call('realpath', raw.replace(/^~(?=\/|$)/, home))).replace(/\/$/, '') || '/';
    const windows = /^\/?[A-Za-z]:\//.test(root), norm = v => windows ? v.toLowerCase() : v;
    const inside = full => norm(full) === norm(root) || norm(full).startsWith(norm(root === '/' ? '' : root) + '/');
    const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    async function resolve(value, allowRoot = false, missing = false) {
      if (typeof value !== 'string' || value.includes('\0') || value.replace(/\\/g, '/').split('/').includes('..')) fail('路径无效');
      const full = path.resolve(root, value.replace(/\\/g, '/') || '.');
      if (!inside(full) || !allowRoot && norm(full) === norm(root)) fail('路径超出工作区');
      const rel = path.relative(root, full);
      if (rel.split('/').some(part => ['.git', '.agenthub-trash'].includes(part.toLowerCase()) || part.includes(':'))) fail('不能操作 Git 或回收目录');
      let candidate = full;
      for (;;) {
        try { const real = await call('realpath', candidate); if (!inside(real) || path.relative(root, real).split('/').includes('.git')) fail('符号链接超出工作区或指向 Git'); break; }
        catch (error) { if (!missing || ![2, 'ENOENT'].includes(error.code)) throw error; const parent = path.dirname(candidate); if (candidate === parent) throw error; candidate = parent; }
      }
      return { full, rel };
    }
    const entry = async (full, known) => { const stat = known || await call('lstat', full); return { path: full, rel: path.relative(root, full), name: path.basename(full), dir: stat.isDirectory(), link: stat.isSymbolicLink(), size: stat.isFile() ? stat.size : 0, mtime: Math.round(stat.mtime * 1000) }; };
    const read = full => new Promise((resolve, reject) => {
      const chunks = []; let size = 0; const stream = sftp.createReadStream(full);
      stream.on('data', b => { size += b.length; if (size > MAX) { stream.destroy(); reject(Object.assign(Error('文本文件超过 2MB'), { status: 413 })); } else chunks.push(b); });
      stream.on('error', reject); stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
    async function mkdir(full) {
      if (!inside(full)) fail('路径超出工作区');
      let stat; try { stat = await call('stat', full); } catch (error) { if (![2, 'ENOENT'].includes(error.code)) throw error; }
      if (stat) { if (!stat.isDirectory()) fail('父路径不是目录'); return; }
      await mkdir(path.dirname(full)); await call('mkdir', full);
    }
    if (op === 'find') {
      const dirs = [root], results = []; let scanned = 0;
      const q = String(body.q || '').toLowerCase();
      while (dirs.length && scanned < 20000 && results.length < 200) {
        const dir = dirs.shift();
        for (const item of await call('readdir', dir)) {
          scanned++; const full = path.join(dir, item.filename);
          if (item.attrs.isDirectory() && !['.git', '.agenthub-trash', 'node_modules', '.venv', 'dist', 'build'].includes(item.filename)) dirs.push(full);
          else if (item.attrs.isFile() && item.filename.toLowerCase().includes(q)) results.push(await entry(full, item.attrs));
          if (results.length >= 200 || scanned >= 20000) break;
        }
      }
      return { root, results, scanned, truncated: dirs.length > 0 };
    }
    const target = await resolve(body.path || '', op === 'tree', ['write', 'new'].includes(op));
    if (op === 'tree') {
      const all = (await call('readdir', target.full)).filter(e => e.filename !== '.agenthub-trash');
      const entries = await Promise.all(all.slice(0, 2000).map(e => entry(path.join(target.full, e.filename), e.attrs)));
      return { root, path: target.full, rel: target.rel, entries, truncated: all.length > 2000 };
    }
    if (op === 'text') {
      const stat = await call('stat', target.full); if (!stat.isFile()) fail('不是文本文件'); if (stat.size > MAX) fail('文本文件超过 2MB', 413);
      const info = { path: target.full, rel: target.rel, size: stat.size, mtime: Math.round(stat.mtime * 1000) };
      if (body.meta === '1') return info;
      const bytes = await read(target.full); if (bytes.includes(0)) fail('二进制文件不能编辑');
      return { ...info, text: bytes.toString('utf8'), hash: hash(bytes) };
    }
    if (op === 'write' || op === 'new') {
      if (op === 'write' && (typeof body.content !== 'string' || Buffer.byteLength(body.content) > MAX)) fail('文本内容无效或超过 2MB');
      let stat; try { stat = await call('stat', target.full); } catch (error) { if (![2, 'ENOENT'].includes(error.code)) throw error; }
      if (op === 'new' && stat) fail('同名路径已存在', 409);
      if (stat && !stat.isFile()) fail('目标不是文件');
      if (stat && (body.expectedMtime != null && Math.round(stat.mtime * 1000) !== Number(body.expectedMtime) || body.expectedHash != null && hash(await read(target.full)) !== body.expectedHash)) fail('文件已被修改，请重新读取后保存', 409);
      if (!stat && (body.expectedHash != null || body.expectedMtime != null)) fail('文件已被移动或删除，请重新读取', 409);
      await mkdir(path.dirname(target.full));
      if (op === 'new' && body.kind === 'folder') await call('mkdir', target.full);
      else {
        const bytes = Buffer.from(op === 'new' ? '' : body.content), temp = path.join(path.dirname(target.full), '.agenthub-write-' + crypto.randomUUID());
        await new Promise((resolve, reject) => { const stream = sftp.createWriteStream(temp, { flags: 'wx', ...(stat ? { mode: stat.mode & 0o777 } : {}) }); stream.on('error', reject); stream.on('close', resolve); stream.end(bytes); });
        try {
          if (stat && sftp.ext_openssh_rename) {
            try { await call('ext_openssh_rename', temp, target.full); }
            catch (error) {
              if (error.code !== 8 && !/not support|unsupported/i.test(error.message)) throw error;
              // Plain SFTP v3 cannot replace an existing file. Retain the old
              // file until the replacement succeeds; restore it on failure.
              const backup = path.join(path.dirname(target.full), '.agenthub-backup-' + crypto.randomUUID());
              await call('rename', target.full, backup);
              try { await call('rename', temp, target.full); }
              catch (failed) { await call('rename', backup, target.full).catch(() => { failed.message += '；旧文件保留在 ' + backup; }); throw failed; }
              await call('unlink', backup);
            }
          } else await call('rename', temp, target.full);
        }
        finally { await call('unlink', temp).catch(() => {}); }
      }
      const info = await entry(target.full);
      return { ok: true, ...info, created: !stat, ...(op === 'new' ? { entry: info } : { hash: hash(Buffer.from(body.content)) }) };
    }
    if (op === 'rename' || op === 'move') {
      if (op === 'rename' && (typeof body.name !== 'string' || !body.name.trim() || /[\\/\0]/.test(body.name))) fail('名称无效');
      const dest = await resolve(op === 'rename' ? path.join(path.dirname(target.full), body.name) : path.join((await resolve(body.targetDir || '', true)).full, path.basename(target.full)), false, true);
      if (dest.full.startsWith(target.full + '/')) fail('不能移入自身子目录');
      let exists = false; try { await call('lstat', dest.full); exists = true; } catch (error) { if (![2, 'ENOENT'].includes(error.code)) throw error; }
      if (exists) fail('目标已存在', 409);
      await call('rename', target.full, dest.full); return { ok: true, ...await entry(dest.full) };
    }
    if (op === 'delete') {
      const trashRoot = path.join(root, '.agenthub-trash');
      try { const stat = await call('lstat', trashRoot); if (stat.isSymbolicLink()) fail('回收目录无效'); } catch (error) { if (![2, 'ENOENT'].includes(error.code)) throw error; }
      const trash = path.join(trashRoot, crypto.randomUUID(), target.rel); await mkdir(path.dirname(trash)); await call('rename', target.full, trash);
      return { ok: true, trash, recoverable: true, rel: target.rel };
    }
    fail('不支持的远程文件操作');
  });
}
module.exports = { execute };
