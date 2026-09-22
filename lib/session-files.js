const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./store');

// 会话消息体拆分存储：sessions.json 只留摘要索引，消息正文按会话写
// data/sessions/<id>.json。避免索引文件随消息积累全量重写（1.8MB 且单调增长）。
// 归档会话的正文在 sessions-archive.jsonl（含完整消息），不走本目录。
// 事件流 data/events/<id>.jsonl 是另一条持久化线（回合事件），与本题无关。

const DIR = path.join(DATA_DIR, 'sessions');
// 事件路由允许的会话 id 字符集是 [A-Za-z0-9:_-]，但 Windows 文件名里 ':' 是
// NTFS 借流（数据会写进流而不是文件），必须替换；替换后理论上可能与含
// '_' 的 id 撞名，实际 id 生成不含冒号，此处防御即可。
const _fingerprints = new Map(); // String(id) -> 上次成功落盘内容的 sha1
// 文件存在但读失败/损坏的 id：进程内禁止用内存内容覆盖（内存此刻可能是补齐
// 失败的空数组），保住原文等下次启动重试读取；真删除（removeMessages）解除
const _unrecovered = new Set();
// 已经「读回验证过」确实存在一份损坏原文备份的 id —— persistAll 允许把新消息写回
// live 文件的唯一前提。写完成功与否不能只凭 writeFileSync 没抛异常。
const _backedUp = new Set();
// 派生缓存兜底（持久化底盘）：正文文件损坏时，用「事件日志」重建消息（best
// effort）。由 server.js 注入实现——它才知道消息块的真实形状。
let _rebuildHook = null;
function setRebuildHook(fn) { _rebuildHook = typeof fn === 'function' ? fn : null; }

function safeName(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, '_'); }
function fileFor(id) { return path.join(DIR, safeName(id) + '.json'); }

// 仅启动/迁移路径使用（同步读）；请求路径的消息一律走内存
function loadMessages(id) {
  const key = String(id);
  let raw;
  try {
    raw = fs.readFileSync(fileFor(id), 'utf8');
  } catch (e) {
    if (e && e.code !== 'ENOENT') _unrecovered.add(key);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('messages file is not an array');
    _unrecovered.delete(key);
    _backedUp.delete(key);
    return parsed;
  } catch {
    // 内容损坏：先保现场（一次性备份），再尝试用事件日志重建；重建成功就
    // 用重建结果覆盖正文（原文已备份），失败才回到「保住现场不覆盖」。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (!_backedUp.has(key)) {
      const backup = fileFor(id) + '.corrupt-' + stamp + '-' + crypto.randomBytes(4).toString('hex') + '.json';
      try {
        fs.writeFileSync(backup, raw);
        // 读回来比对才算真有。放行覆盖 live 文件的全部依据就是这一份副本，
        // 写完不验证等于拿一个「也许没落盘」的副本去换掉原文。
        if (fs.readFileSync(backup, 'utf8') === raw) _backedUp.add(key);
      } catch {}
    }
    if (_rebuildHook && _backedUp.has(key)) {
      try {
        const rebuilt = _rebuildHook(key);
        if (Array.isArray(rebuilt) && rebuilt.length) {
          const tmp = fileFor(id) + '.' + process.pid + '.rebuild.tmp';
          fs.writeFileSync(tmp, JSON.stringify(rebuilt));
          fs.renameSync(tmp, fileFor(id));
          _fingerprints.set(key, crypto.createHash('sha1').update(JSON.stringify(rebuilt)).digest('hex'));
          _unrecovered.delete(key);
          _backedUp.delete(key);
          console.error('[sessions] ' + key + ' 正文损坏，已用事件日志重建 ' + rebuilt.length + ' 条消息（原文备份为 .corrupt-*.json）');
          return rebuilt;
        }
      } catch (e) {
        console.error('[sessions] 事件日志重建失败:', e.message);
      }
    }
    _unrecovered.add(key); // 重建也失败：保住现场，不覆盖，留待人工或下次启动
    return null;
  }
}

// 把每个会话的 messages 写到独立文件（内容没变的按 sha1 跳过）。
// 返回写入失败的 id 集合——调用方序列化索引时对这些会话保留内联消息，
// 宁可索引临时变大，不可丢消息。
function persistAll(sessions) {
  const failed = new Set();
  let dirReady = false;
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || s.id == null) continue;
    const id = String(s.id);
    // 读失败过的文件默认绝不覆盖（见 _unrecovered 注释）。但损坏原文此刻已经备份成
    // .corrupt-*.json，现场保住了；一直拒绝写入会让这个会话之后产生的每条消息都落不了
    // 盘——索引里 messages 被剥掉、正文又不让写，重启后新消息凭空消失。所以「已备份并
    // 读回验证 + 内存里确实有消息」时放行；正文仍为空的（刚启动还没补齐）继续保住现场等人工处理。
    // 单会话整体一个 try：messages 上的任何异常（如序列化抛错）都只记入
    // failed，由调用方把该会话内联回索引，不影响其余会话落盘。
    try {
      if (!Array.isArray(s.messages)) continue;
      if (_unrecovered.has(id) && !(_backedUp.has(id) && s.messages.length)) {
        // Preserve unreadable evidence, but report unsaved new content so the
        // index serializer retains it instead of silently discarding it.
        if (s.messages.length) failed.add(id);
        continue;
      }
      const json = JSON.stringify(s.messages);
      const fp = crypto.createHash('sha1').update(json).digest('hex');
      if (_fingerprints.get(id) === fp) continue;
      if (!dirReady) { fs.mkdirSync(DIR, { recursive: true }); dirReady = true; }
      const tmp = fileFor(id) + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, fileFor(id));
      _fingerprints.set(id, fp);
      _unrecovered.delete(id); // 已经成功写回，正文不再是「未恢复」状态
      _backedUp.delete(id);
    } catch {
      failed.add(id);
    }
  }
  return failed;
}

function removeMessages(id) {
  const key = String(id);
  _fingerprints.delete(key);
  _unrecovered.delete(key);
  _backedUp.delete(key);
  try { fs.unlinkSync(fileFor(id)); } catch {}
}

// 启动清扫：不属于活跃列表也不属于归档的消息文件按孤儿删除。
// 例外：人工取证文件永不清理——损坏原文备份（.corrupt-*.json）与重建临时文件
// 都是"事件已发生"的证据，扫掉等于违背"保住现场"的承诺（曾真被扫掉过）。
function sweepOrphans(validIds) {
  let names;
  try { names = fs.readdirSync(DIR); } catch { return; }
  const valid = new Set([...(validIds || [])].map(id => safeName(id) + '.json'));
  for (const name of names) {
    // 崩溃会留下 <id>.json.<pid>.<hex>.tmp：它永远不是有效数据（正常写入的最后一步
    // 是 rename），而本函数只在启动时跑、没有并发写入，所以直接删掉。留着会一路被
    // 备份打包带走、越积越多。重建临时文件除外（见上）。
    if (name.endsWith('.tmp') && !name.includes('.rebuild.')) {
      try { fs.unlinkSync(path.join(DIR, name)); } catch {}
      continue;
    }
    if (!name.endsWith('.json') || valid.has(name)) continue;
    if (name.includes('.corrupt-') || name.includes('.rebuild.')) continue;
    try { fs.unlinkSync(path.join(DIR, name)); } catch {}
  }
}

module.exports = { DIR, fileFor, loadMessages, persistAll, removeMessages, sweepOrphans, setRebuildHook };
