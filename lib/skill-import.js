// Copy a local skill into a Claude skill root without following symlinks.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILES = 150;
const MAX_BYTES = 5 * 1024 * 1024;
function inspect(source) {
  const root = path.resolve(String(source || ''));
  let st;
  try { st = fs.statSync(root); } catch { throw new Error('技能文件夹不存在或不可访问：' + root); }
  if (!path.isAbsolute(String(source || '')) || !st.isDirectory()) throw new Error('请选择本机技能文件夹');
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('技能来源不能是符号链接');
  const name = path.basename(root);
  // Windows 保留设备名（不区分大小写、可带扩展名）做成目录会在后续操作里炸
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) throw new Error('技能文件夹名称是 Windows 保留名，请改名后重试');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name) || name === '.' || name === '..') throw new Error('技能文件夹名称无效');
  const files = [];
  let total = 0;
  const walk = (dir, depth) => {
    if (depth > 8) throw new Error('技能目录嵌套过深');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error('技能目录包含符号链接：' + entry.name);
      if (stat.isDirectory()) { walk(full, depth + 1); continue; }
      if (!stat.isFile()) throw new Error('技能目录包含不支持的文件：' + entry.name);
      total += stat.size;
      files.push(full);
      if (files.length > MAX_FILES || total > MAX_BYTES) throw new Error('技能超过导入上限（150 个文件 / 5 MB）');
    }
  };
  walk(root, 0);
  if (!files.includes(path.join(root, 'SKILL.md'))) throw new Error('技能根目录缺少 SKILL.md');
  const head = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8').slice(0, 8192);
  const description = (/^description:\s*(.+)$/m.exec(head) || [,''])[1].trim().replace(/^["']|["']$/g, '').slice(0, 160);
  return { root, name, files, total, description };
}

// zip 导入：files = [{path, data(base64)}]。先落到临时目录，再走 importSkill 的
// 全部校验（SKILL.md 必在根、名称合法、上限、无符号链接——解包产物天然无链接，
// 但保留同一套闸门让两条导入路径的安全语义完全一致）。
function importZip(files, destinationRoot) {
  const os = require('os');
  const list = Array.isArray(files) ? files.slice(0, 200) : [];
  if (!list.length) throw new Error('zip 里没有可导入的文件');
  // 归一化：去掉顶层目录（zip 常见形态是 <skill>/SKILL.md），使 SKILL.md 落在根
  const cleaned = [];
  for (const f of list) {
    const clean = String(f && f.path || '').replace(/\\/g, '/').split('/').filter(x => x && x !== '.' && x !== '..').join('/');
    if (!clean || clean.includes('..')) throw new Error('zip 内路径非法：' + (f && f.path));
    cleaned.push({ path: clean, data: String(f.data || '') });
  }
  const topDirs = new Set(cleaned.map(f => f.path.split('/')[0]));
  const stripTop = cleaned.every(f => f.path.includes('/')) && topDirs.size >= 1 && cleaned.some(f => /^([^/]+\/)SKILL\.md$/i.test(f.path));
  const finalPaths = cleaned.map(f => ({ path: stripTop ? f.path.split('/').slice(1).join('/') : f.path, data: f.data })).filter(f => f.path);
  if (!finalPaths.some(f => /^SKILL\.md$/i.test(f.path))) throw new Error('zip 根目录缺少 SKILL.md（或唯一顶层目录内缺少 SKILL.md）');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-skill-zip-'));
  try {
    // 技能名 = 剥离前 zip 的顶层目录名；无顶层目录时取 SKILL.md 头部的 name 字段兜底。
    // 必须在临时根里再建同名子目录，否则 importSkill 会拿临时目录名当技能名。
    let skillName = '';
    if (stripTop && topDirs.size) skillName = String([...topDirs][0]);
    if (!skillName) {
      const skillMd = finalPaths.find(f => /^SKILL\.md$/i.test(f.path));
      const head = Buffer.from(skillMd.data, 'base64').toString('utf8').slice(0, 4096);
      skillName = (/^name:\s*(\S+)/m.exec(head) || [])[1] || '';
    }
    skillName = skillName.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
    if (!skillName || skillName === '.' || skillName === '..') skillName = 'imported-skill';
    const stage = path.join(tmp, skillName);
    fs.mkdirSync(stage, { recursive: true });
    for (const f of finalPaths) {
      const out = path.join(stage, f.path);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const buf = Buffer.from(f.data, 'base64');
      if (!buf.length) throw new Error('文件内容为空：' + f.path);
      fs.writeFileSync(out, buf);
    }
    return importSkill(stage, destinationRoot);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function importSkill(source, destinationRoot) {
  const skill = inspect(source);
  const root = path.resolve(destinationRoot);
  // An existing .claude or skills symlink could redirect a copy outside the
  // requested project. Reject each existing segment before creating anything.
  const ancestors = [];
  for (let current = root; current !== path.dirname(current); current = path.dirname(current)) ancestors.push(current);
  for (const segment of ancestors.reverse()) {
    try { if (fs.lstatSync(segment).isSymbolicLink()) throw new Error('目标技能目录包含符号链接'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, skill.name);
  try { fs.lstatSync(target); throw new Error('已有同名技能，请先处理现有目录：' + skill.name); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(root, '.agenthub-import-' + crypto.randomBytes(8).toString('hex'));
  try {
    fs.mkdirSync(temporary);
    for (const file of skill.files) {
      const relative = path.relative(skill.root, file);
      const output = path.join(temporary, relative);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(file, output);
    }
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
  }
  return { name: skill.name, description: skill.description, fileCount: skill.files.length, bytes: skill.total, path: target };
}

module.exports = { inspect, importSkill, importZip };
