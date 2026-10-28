// Executed on the target through stdin; has no dependency outside Node stdlib.
async function execute(request) {
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const { execFile } = require('child_process');
  const bad = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
  if (typeof request.root !== 'string' || !request.root.trim()) bad('远程工作目录不能为空');
  const rawRoot = request.root.replace(/^~(?=[/\\]|$)/, require('os').homedir()), root = fs.realpathSync(rawRoot);
  if (!fs.statSync(root).isDirectory()) bad('工作目录不是文件夹');
  function resolve(raw, allowRoot = false, missing = false) {
    if (typeof raw !== 'string' || raw.includes('\0') || raw.split(/[\\/]/).includes('..')) bad('路径无效');
    const full = path.resolve(root, raw || '.'); let rel = path.relative(root, full);
    if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel) || !rel && !allowRoot) bad('路径超出工作区');
    if (rel.split(path.sep).some(s => ['.git', '.agenthub-trash'].includes(s.toLowerCase()) || s.includes(':'))) bad('不能操作 Git 或回收目录');
    let real = full, tail = [];
    while (!fs.existsSync(real)) { if (!missing) bad('路径不存在'); tail.unshift(path.basename(real)); const parent = path.dirname(real); if (real === parent) bad('路径不存在'); real = parent; }
    real = path.join(fs.realpathSync(real), ...tail); rel = path.relative(root, real);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel) || rel.split(path.sep).some(s => s.toLowerCase() === '.git')) bad('符号链接超出工作区或指向 Git');
    return { full, rel: path.relative(root, full).replace(/\\/g, '/') };
  }
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  function entry(full) { const stat = fs.lstatSync(full); return { path: full, rel: path.relative(root, full).replace(/\\/g, '/'), name: path.basename(full), dir: stat.isDirectory(), link: stat.isSymbolicLink(), size: stat.isFile() ? stat.size : 0, mtime: Math.round(stat.mtimeMs) }; }
  const body = request.body || {}, op = request.op;
  if (op.startsWith('git.')) {
    const git = (args, env = {}, options = {}) => new Promise((resolve, reject) => execFile('git', ['-c', 'core.quotePath=false', ...args], { cwd: options.cwd || root, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', ...env } }, (error, out, err) => error && !(options.allowDifference && error.code === 1) ? reject(Object.assign(new Error(String(err || out || error.message).slice(0, 4000)), { status: 400 })) : resolve(out)));
    const action = op.slice(4), head = (await git(['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim();
    if (['commit', 'push', 'pull'].includes(action) && body.expectedHead !== head) bad('远程 HEAD 已改变，请刷新后重试', 409);
    const snapshotRef = id => { if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(id || ''))) bad('回合快照标识无效'); return 'refs/agenthub/ckpt/' + id; };
    if (action === 'snapshot') {
      const repo = fs.realpathSync((await git(['rev-parse', '--show-toplevel'])).trim());
      if (repo !== root) bad('远程自动差异需要使用 Git 仓库根目录');
      const extra = (await git(['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
      let bytes = 0;
      if (extra.length > 500) bad('未跟踪文件超过 500 个，已跳过远程快照');
      for (const name of extra) { const item = resolve(name); bytes += fs.lstatSync(item.full).size; }
      if (bytes > 50 * 1024 * 1024) bad('未跟踪文件超过 50 MB，已跳过远程快照');
      const index = path.join(require('os').tmpdir(), 'agenthub-index-' + crypto.randomUUID()), env = { GIT_INDEX_FILE: index };
      try {
        await git(head ? ['read-tree','HEAD'] : ['read-tree','--empty'], env);
        await git(['add','--all','--','.'], env);
        const tree = (await git(['write-tree'], env)).trim(), id = 'remote-' + crypto.randomUUID();
        await git(['update-ref',snapshotRef(id),tree]);
        return { ok:true,id,tree };
      } finally { try { fs.unlinkSync(index); } catch {} }
    }
    if (action === 'snapshotDelete') { await git(['update-ref','-d',snapshotRef(body.id)]); return {ok:true}; }
    if (action === 'turnDiff') {
      const refs = [snapshotRef(body.beforeId),snapshotRef(body.afterId)];
      if (body.path) { const file = resolve(body.path, false, true); return {ok:true,patch:await git(['diff','--no-ext-diff','--no-textconv',...refs,'--',file.rel])}; }
      const [raw, names] = await Promise.all([
        git(['diff','--numstat','-z','--no-renames',...refs,'--']),
        git(['diff','--name-status','-z','--no-renames',...refs,'--'])
      ]), files=[], statuses=new Map(), parts=names.split('\0');
      for(let i=0;i+1<parts.length;i+=2) statuses.set(parts[i+1],parts[i]);
      for (const row of raw.split('\0').filter(Boolean).slice(0,200)) {
        const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row); if (!match) continue;
        files.push({path:match[3],status:statuses.get(match[3])||'M',additions:Number(match[1])||0,deletions:Number(match[2])||0,binary:match[1]==='-'});
      }
      return {ok:true,files,truncated:raw.split('\0').length>201};
    }
    if (action === 'status') {
      const repo = fs.realpathSync((await git(['rev-parse', '--show-toplevel'])).trim());
      const atRepo = args => git(args, { GIT_OPTIONAL_LOCKS: '0' }, { cwd: repo });
      const raw = await atRepo(['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all']), parts = raw.split('\0'), branchLine = parts.shift() || '';
      const files = [];
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]; if (!p) continue;
        const xy = p.slice(0, 2), oldPath = /[RC]/.test(xy) ? parts[++i] || '' : '';
        files.push({ path: p.slice(3), oldPath, status: xy, x: xy[0], y: xy[1], staged: xy[0] !== ' ' && xy[0] !== '?', unstaged: xy[1] !== ' ' || xy === '??' });
      }
      function numstat(text) {
        const records = text.split('\0'), result = new Map();
        for (let i = 0; i < records.length; i++) {
          const match = records[i].match(/^([^\t]+)\t([^\t]+)\t(.*)$/s); if (!match) continue;
          let name = match[3];
          if (!name && records[i + 2]) { name = records[i + 2]; i += 2; }
          if (!name) continue;
          const current = result.get(name) || { added: 0, deleted: 0, lineNote: '' };
          if (match[1] === '-' || match[2] === '-') { current.added = null; current.deleted = null; current.lineNote = '二进制'; }
          else if (current.added !== null) { current.added += Number(match[1]); current.deleted += Number(match[2]); }
          result.set(name, current);
        }
        return result;
      }
      let remainingBytes = 32 * 1024 * 1024;
      async function untracked(name) {
        const full = path.resolve(repo, name), relative = path.relative(repo, full);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return { added:null, deleted:null, lineNote:'行数不可用' };
        try {
          const stat = await fs.promises.lstat(full);
          if (stat.isSymbolicLink()) return { added:null, deleted:null, lineNote:'符号链接' };
          if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || stat.size > remainingBytes) return { added:null, deleted:null, lineNote:stat.size > 2 * 1024 * 1024 ? '大文件' : '行数不可用' };
          remainingBytes -= stat.size;
          const bytes = await fs.promises.readFile(full);
          if (bytes.includes(0)) return { added:null, deleted:null, lineNote:'二进制' };
          let lines = 0; for (const byte of bytes) if (byte === 10) lines++;
          if (bytes.length && bytes[bytes.length - 1] !== 10) lines++;
          return { added:lines, deleted:0, lineNote:'' };
        } catch { return { added:null, deleted:null, lineNote:'行数不可用' }; }
      }
      const [working, staged] = files.length ? await Promise.all([
        atRepo(['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z']).then(numstat).catch(() => null),
        atRepo(['diff', '--no-ext-diff', '--no-textconv', '--cached', '--numstat', '-z']).then(numstat).catch(() => null),
      ]) : [new Map(), new Map()];
      const zero = { added:0, deleted:0, lineNote:'' }, unavailable = { added:null, deleted:null, lineNote:'行数统计失败' };
      for (const file of files) {
        const w = file.status === '??' ? await untracked(file.path) : working ? working.get(file.path) || zero : unavailable;
        const s = staged ? staged.get(file.path) || zero : unavailable;
        file.stagedAdded = file.staged ? s.added : 0; file.stagedDeleted = file.staged ? s.deleted : 0;
        file.unstagedAdded = file.unstaged ? w.added : 0; file.unstagedDeleted = file.unstaged ? w.deleted : 0;
        const reported = [file.staged ? s : zero, file.unstaged ? w : zero];
        file.added = reported.some(n => n.added === null) ? null : reported.reduce((n, v) => n + v.added, 0);
        file.deleted = reported.some(n => n.deleted === null) ? null : reported.reduce((n, v) => n + v.deleted, 0);
        file.lineNote = reported.find(n => n.lineNote)?.lineNote || '';
      }
      return { ok: true, cwd: root, repoRoot:repo, head, branch: branchLine.replace(/^## /, '').replace(/^(?:No commits yet on|Initial commit on) /, '').split('...')[0], files, statsScope:'staged-and-working', lineStatsVersion:1 };
    }
    if (action === 'diff') {
      const repo = fs.realpathSync((await git(['rev-parse','--show-toplevel'])).trim());
      let name = '';
      if (body.path) {
        if (typeof body.path !== 'string' || body.path.includes('\0') || body.path.split(/[\\/]/).some(p => p === '..' || p.toLowerCase() === '.git')) bad('路径无效');
        name = path.relative(repo, path.resolve(repo, body.path));
        if (!name || name === '..' || name.startsWith('..' + path.sep) || path.isAbsolute(name)) bad('路径超出仓库');
      }
      const atRepo = (args, allowDifference = false) => git(args, {}, { cwd:repo, allowDifference });
      const normalizedName = process.platform === 'win32' ? name.replace(/\\/g,'/') : name;
      const paths = name ? ['--', ':(top,literal)' + normalizedName] : [];
      if (name) {
        const records = (await atRepo(['status','--porcelain=v1','-z','--untracked-files=no'])).split('\0');
        for (let i=0;i<records.length;i++) if (/^[RC]|^ [RC]/.test(records[i])) {
          const destination = records[i].slice(3), old = records[++i];
          if (destination === normalizedName && old) paths.push(':(top,literal)' + old);
        }
      }
      const base = ['diff','--no-ext-diff','--no-textconv'];
      const [working, staged] = await Promise.all([atRepo([...base,...paths]),atRepo([...base,'--cached',...paths])]);
      let text = body.scope === 'staged' ? staged : body.scope === 'working' ? working : staged && working ? '# 已暂存\n' + staged + '\n# 未暂存\n' + working : staged || working;
      if (!text && name && body.scope !== 'staged' && await atRepo(['ls-files','--others','--exclude-standard','-z',...paths])) {
        text = await atRepo(['diff','--no-index','--no-ext-diff','--no-textconv','--',process.platform === 'win32' ? 'NUL' : '/dev/null',path.join(repo,name)],true);
      }
      return { ok:true,diff:text.slice(0,512*1024),head,truncated:text.length>512*1024 };
    }
    if (action === 'stage') { const file = resolve(body.path, false, true); return { ok: true, output: await git(body.stage === false ? (head ? ['reset', '-q', 'HEAD', '--', file.rel] : ['rm', '--cached', '--', file.rel]) : ['add', '--', file.rel]) }; }
    if (action === 'commit') { if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 10000) bad('提交说明无效'); const output = await git(['commit', '-m', body.message]); return { ok: true, output, head: (await git(['rev-parse', 'HEAD'])).trim() }; }
    if (action === 'push') return { ok: true, output: await git(['push']) };
    if (action === 'pull') return { ok: true, output: await git(['pull', '--ff-only']) };
    if (action === 'fetch') return { ok: true, output: await git(['fetch', '--prune']) };
    bad('未知远程 Git 操作');
  }
  if (op === 'find') {
    const q = String(body.q || '').toLowerCase(), dirs = [root], results = []; let scanned = 0;
    while (dirs.length && results.length < 200 && scanned < 20000) { const dir = dirs.shift(); for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name); scanned++;
      if (e.isDirectory() && !['.git', '.agenthub-trash', 'node_modules', '.venv', 'dist', 'build'].includes(e.name)) dirs.push(full);
      else if (e.isFile() && e.name.toLowerCase().includes(q)) results.push(entry(full));
    } }
    return { root, results: results.slice(0, 200), scanned, truncated: dirs.length > 0 };
  }
  const target = resolve(body.path || '', op === 'tree', ['new', 'write'].includes(op));
  if (op === 'tree') { const all = fs.readdirSync(target.full).filter(n => n !== '.agenthub-trash').slice(0, 2001).map(n => entry(path.join(target.full, n))); return { root, path: target.full, rel: target.rel, entries: all.slice(0, 2000), truncated: all.length > 2000 }; }
  if (op === 'text') {
    const stat = fs.statSync(target.full); if (!stat.isFile()) bad('不是文本文件');
    if (stat.size > 2 * 1024 * 1024) bad('文本文件超过 2MB', 413);
    if (body.meta === '1') return { path: target.full, rel: target.rel, size: stat.size, mtime: Math.round(stat.mtimeMs) };
    const bytes = fs.readFileSync(target.full); if (bytes.includes(0)) bad('二进制文件不能编辑');
    return { path: target.full, rel: target.rel, text: bytes.toString('utf8'), size: bytes.length, mtime: Math.round(stat.mtimeMs), hash: hash(bytes) };
  }
  if (op === 'write') {
    if (typeof body.content !== 'string' || Buffer.byteLength(body.content) > 2 * 1024 * 1024) bad('文本内容无效或超过 2MB');
    const existed = fs.existsSync(target.full);
    if (existed) { const stat = fs.statSync(target.full); if (!stat.isFile()) bad('目标不是文件'); if (body.expectedHash != null && hash(fs.readFileSync(target.full)) !== body.expectedHash || body.expectedMtime != null && Math.round(stat.mtimeMs) !== Number(body.expectedMtime)) bad('文件已被修改，请重新读取后保存', 409); }
    else if (body.expectedHash != null || body.expectedMtime != null) bad('文件已被移动或删除，请重新读取', 409);
    fs.mkdirSync(path.dirname(target.full), { recursive: true }); const tmp = path.join(path.dirname(target.full), '.agenthub-write-' + crypto.randomUUID());
    try { fs.writeFileSync(tmp, body.content, { mode: existed ? fs.statSync(target.full).mode : undefined }); fs.renameSync(tmp, target.full); } finally { try { fs.unlinkSync(tmp); } catch {} }
    return { ok: true, ...entry(target.full), created: !existed, hash: hash(Buffer.from(body.content)) };
  }
  if (op === 'new') { if (fs.existsSync(target.full)) bad('同名路径已存在', 409); fs.mkdirSync(path.dirname(target.full), { recursive: true }); if (body.kind === 'folder') fs.mkdirSync(target.full); else fs.writeFileSync(target.full, '', { flag: 'wx' }); return { ok: true, ...entry(target.full), entry: entry(target.full) }; }
  if (op === 'rename' || op === 'move') {
    if (op === 'rename' && (typeof body.name !== 'string' || !body.name.trim() || /[\\/\0]/.test(body.name))) bad('名称无效');
    const dest = resolve(op === 'rename' ? path.join(path.dirname(target.full), body.name) : path.join(resolve(body.targetDir || '', true).full, path.basename(target.full)), false, true);
    if (fs.existsSync(dest.full)) bad('目标已存在', 409); if (fs.statSync(target.full).isDirectory() && dest.full.startsWith(target.full + path.sep)) bad('不能移入自身子目录'); fs.renameSync(target.full, dest.full); return { ok: true, ...entry(dest.full) };
  }
  if (op === 'delete') {
    const trashRoot = path.join(root, '.agenthub-trash'); if (fs.existsSync(trashRoot) && (fs.lstatSync(trashRoot).isSymbolicLink() || fs.realpathSync(trashRoot) !== trashRoot)) bad('回收目录无效');
    const trash = path.join(trashRoot, crypto.randomUUID(), target.rel); fs.mkdirSync(path.dirname(trash), { recursive: true }); fs.renameSync(target.full, trash); return { ok: true, trash, recoverable: true, rel: target.rel };
  }
  bad('该远程文件操作尚不支持');
}
module.exports = { execute };
if (require.main === module) { let input = ''; process.stdin.on('data', b => input += b); process.stdin.on('end', async () => { try { process.stdout.write(JSON.stringify({ result: await execute(JSON.parse(input)) })); } catch (e) { process.stdout.write(JSON.stringify({ error: e.message, status: e.status || 400 })); } }); }
