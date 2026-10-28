const crypto = require('crypto');
const fs = require('fs'), path = require('path');
const { durable, fail, string, record } = require('./workflow-store');
const valid = d => Array.isArray(d.items) && d.items.length <= 200 && d.items.every(a => record(a) && /^html_[a-f0-9]{24}$/.test(a.id) && typeof a.html === 'string' && a.html.length <= 1024 * 1024 && typeof a.sessionId === 'string' && Number.isSafeInteger(a.revision));
const store = durable('html-artifacts', { items: [] }, valid);
function list(sessionId) { return store.read().items.filter(a => !sessionId || a.sessionId === sessionId).map(({ html, ...a }) => a); }
function get(id) { return store.read().items.find(a => a.id === id) || null; }
function publish(input, session) {
  const title = string(input.title, '成果名称', 200, '交互成果').trim(); let html = string(input.html, 'HTML', 1024 * 1024);
  if (!html.trim()) fail('HTML 不能为空');
  const imageFiles = input.imageFiles || []; if (!Array.isArray(imageFiles) || imageFiles.length > 20) fail('本地图片最多 20 张');
  for (const image of imageFiles) {
    if (!record(image) || !session.cwd || session.remoteHostId) fail('嵌入本地图片需要本机项目');
    const raw = string(image.path, '图片路径', 4000), src = string(image.src, 'HTML 图片引用', 4000, raw);
    const root = fs.realpathSync(session.cwd), file = fs.realpathSync(path.resolve(root, raw)), rel = path.relative(root, file);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel) || rel.split(path.sep).some(p => p.toLowerCase() === '.git')) fail('图片超出工作区');
    const mime = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif', '.svg':'image/svg+xml' }[path.extname(file).toLowerCase()];
    if (!mime || fs.statSync(file).size > 768 * 1024) fail('成果图片类型无效或超过 768 KiB');
    const url = 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64'); let found = false;
    html = html.replace(/(<img\b[^>]*\bsrc\s*=\s*)(["'])([^"']*)\2/gi, (match, prefix, quote, value) => { if (value !== src) return match; found = true; return prefix + quote + url + quote; });
    if (!found) fail('HTML 中没有图片引用：' + src); if (html.length > 1024 * 1024) fail('嵌入图片后的成果超过 1 MiB');
  }
  const id = input.id || 'html_' + crypto.createHash('sha256').update(session.id + '\0' + title + '\0' + html).digest('hex').slice(0, 24);
  if (!/^html_[a-f0-9]{24}$/.test(id)) fail('成果 ID 无效');
  const old = get(id);
  if (input.id && !old) fail('成果不存在', 404);
  if (old && old.sessionId !== session.id) fail('不能改变成果来源', 409);
  if (old?.html === html && old.title === title) return { ...old, html: undefined, url: '/api/html-artifacts/' + id + '/content' };
  if (old && input.expectedRevision !== old.revision) fail('成果已被其他页面修改', 409);
  const next = { id, title, html, sessionId: session.id, revision: (old?.revision || 0) + 1, updatedAt: Date.now() };
  store.change(data => { data.items = [next, ...data.items.filter(a => a.id !== id)]; });
  return { ...next, html: undefined, url: '/api/html-artifacts/' + id + '/content' };
}
function remove(id, revision) { store.change(data => { const a = data.items.find(a => a.id === id); if (!a) fail('成果不存在', 404); if (a.revision !== revision) fail('成果已改变，请刷新', 409); data.items = data.items.filter(a => a.id !== id); }); }
const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts; frame-ancestors 'self'";
function themed(html, theme) { const light = ['paper','cottage','forest','light'].includes(theme); const style = `<style>:root{color-scheme:${light?'light':'dark'};--background:${light?'#ffffff':'#17181b'};--foreground:${light?'#17181b':'#f4f4f5'};--accent:#638bff}body{background:var(--background);color:var(--foreground)}</style>`; return /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, m => m + style) : /^\s*<!doctype[^>]*>/i.test(html) ? html.replace(/<!doctype[^>]*>/i, m => m + style) : style + html; }
module.exports = { list, get, publish, remove, policy, themed };
