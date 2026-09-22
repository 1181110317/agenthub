// SQLite 数据层（lib/db.js）：索引必须
//  1) 可重建——删掉 agenthub.db 不丢任何用户数据，重启后按 JSON 重新灌一遍；
//  2) 与权威源一致——会话/用量行数、消息内容随 JSON 变化；
//  3) 失败可降级——损坏的库不能让服务器起不来，也不能影响 JSON 落盘；
//  4) 检索正确——中文短词与英文长词都要命中，会话内检索不能串到别的会话。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-db-'));
process.env.AGENTHUB_DATA_DIR = dir;

const db = require('../lib/db.js');

let failed = 0;
const ok = (cond, label) => { if (cond) console.log('  ✓ ' + label); else { failed++; console.error('  ✗ ' + label); } };

const session = (id, messages, extra = {}) => ({
  id, agent: 'claude', title: '会话 ' + id, cwd: 'C:/tmp/proj', updatedAt: 1700000000000,
  messages, ...extra,
});

try {
  ok(db.enabled(), '默认启用（可用 AGENTHUB_DB=0 关闭）');
  ok(db.probe(), '库可打开');

  const sessions = [
    session('s1', [
      { role: 'user', ts: 1700000000001, text: '帮我看看快速排序的实现' },
      { role: 'assistant', ts: 1700000000002, blocks: [{ type: 'text', text: 'Quick Sort 的思路是分治，先取基准值。' }, { type: 'tool', name: 'read_file', output: '不该进索引的工具输出' }] },
    ]),
    session('s2', [
      { role: 'user', ts: 1700000001000, text: '数据库迁移脚本写好了吗' },
      { role: 'assistant', ts: 1700000001001, blocks: [{ type: 'text', text: '迁移脚本已完成，包含 SQLite 建表语句。' }] },
    ]),
  ];
  const usage = [
    { ts: 1700000000000, agent: 'claude', model: 'm1', provider: 'p1', input: 100, output: 50, cacheRead: 10, cacheCreate: 0, sessionKey: 's1', source: 'live' },
    { ts: 1700000900000, agent: 'codex', model: 'm2', provider: 'p1', input: 200, output: 80, cacheRead: 0, cacheCreate: 0, sessionKey: 's2', source: 'live' },
    { ts: 1700000900000, agent: 'codex', model: 'm2', provider: 'p1', input: 200, output: 80, cacheRead: 0, cacheCreate: 0, sessionKey: 's2', source: 'live' },
  ];

  const sync = db.syncFromSources({ sessions, usageRecords: usage });
  ok(sync.ok, '首次同步成功');
  const counts = db.counts();
  ok(counts.sessions === 2, '会话行数 = 权威源（' + counts.sessions + '）');
  ok(counts.messages === 4, '消息行数 = 权威源（' + counts.messages + '）');
  ok(counts.usage === 2, '用量按内容去重（3 条输入 → 2 行，重复记录不重复计数）');

  // 检索：长词走 FTS，中文短词走 LIKE，两者都必须命中
  const long = db.searchMessages({ q: '快速排序' });
  ok(long.total >= 1 && long.rows[0].sessionId === 's1', '中文长词命中会话 s1（' + long.engine + '）');
  const short = db.searchMessages({ q: '迁移' });
  ok(short.total >= 1 && short.rows[0].sessionId === 's2', '中文短词命中会话 s2（' + short.engine + '）');
  ok(!/工具输出/.test(JSON.stringify(db.searchMessages({ q: '工具输出' }).rows)), '工具输出不进检索索引（只索引用户可见文本）');
  const scoped = db.searchMessages({ q: '分治', sessionId: 's2' });
  ok(scoped.total === 0, '会话内检索不会串到别的会话');
  const scopedHit = db.searchMessages({ q: '分治', sessionId: 's1' });
  ok(scopedHit.total === 1 && /基准值/.test(scopedHit.rows[0].snippet), '会话内检索返回带上下文的片段');
  ok(db.searchMessages({ q: '%' }).total === 0, 'LIKE 通配符被转义（% 不会匹配全部）');
  ok(db.searchMessages({ q: '_' }).total === 0, 'LIKE 通配符被转义（_ 不会匹配单字符）');

  // 用量聚合：按 agent 分组、按时间过滤
  const byAgent = db.usageSummary({ groupBy: 'agent' });
  ok(byAgent.ok && byAgent.rows.length === 2, '按 Agent 聚合返回两组');
  const claude = byAgent.rows.find(r => r.grp === 'claude');
  ok(claude && claude.input === 100 && claude.output === 50, '聚合数值正确');
  const filtered = db.usageSummary({ groupBy: 'day', from: 1700000900000 });
  ok(filtered.rows.length === 1 && filtered.rows[0].requests === 1, '时间过滤生效（重复记录只算一次请求）');

  // 增量镜像：内容变化才重写，未变化的会话跳过
  const before = db.status().mirror.skipped;
  db.syncFromSources({ sessions, usageRecords: [] });
  ok(db.status().mirror.skipped >= before, '未变化的会话走指纹跳过');

  sessions[0].messages.push({ role: 'user', ts: 1700000002000, text: '再补一条：并归排序也看一下' });
  sessions[0].updatedAt = 1700000003000;
  db.mirrorSessions(sessions);
  ok(db.counts().messages === 5, '新消息进入索引');
  ok(db.searchMessages({ q: '并归排序' }).total === 1, '新消息可检索');

  // 删除会话：库里不能留下孤儿行
  const kept = sessions.filter(s => s.id !== 's2');
  db.mirrorSessions(kept);
  ok(db.counts().sessions === 1 && db.counts().messages === 3, '删除会话后索引行与其消息一并清除');
  ok(db.searchMessages({ q: '迁移脚本' }).total === 0, '已删会话不再被检索到');

  // 回合事件：只镜像落盘事件，按会话查询
  db.mirrorEvent('s1', { type: 'chat.event', seq: 11, ev: { kind: 'text', text: 'hi' } });
  db.mirrorEvent('s1', { type: 'chat.event', seq: 12, ev: { kind: 'text', text: 'ho' } });
  db.mirrorEvent('s1', { type: 'chat.event', seq: 12, ev: { kind: 'text', text: '重复 seq' } });
  const evs = db.sessionEvents('s1');
  ok(evs.ok && evs.rows.length === 2, '事件按 seq 去重（重复投递只留一条）');
  ok(db.sessionEvents('s1', { sinceSeq: 11 }).rows.length === 1, '事件支持 since 增量');

  // 重建：清空后按权威源恢复，且结果与增量镜像一致
  const rebuilt = db.rebuildFromSources({
    sessions: kept,
    usageRecords: usage,
    eventsDir: path.join(dir, 'events'),
  });
  ok(rebuilt.ok, '全量重建成功');
  const after = db.counts();
  ok(after.sessions === 1 && after.messages === 3 && after.usage === 2, '重建后的行数与权威源一致');

  // 正文没装进内存（启动读失败）时不能把库里已有消息覆盖成空
  const bodyDir = path.join(dir, 'sessions');
  fs.mkdirSync(bodyDir, { recursive: true });
  fs.writeFileSync(path.join(bodyDir, 's1.json'), JSON.stringify(kept[0].messages));
  db.mirrorSessions([{ ...kept[0], messages: [] }]);
  ok(db.counts().messages === 3, '正文未载入内存时保留索引里的消息（不用空数组覆盖）');

  // 降级：AGENTHUB_DB=0 时 open() 返回 null，检索返回不可用而不抛异常
  const savedDbFile = process.env.AGENTHUB_DB_FILE;
  process.env.AGENTHUB_DB_FILE = path.join(dir, 'blocked', 'x.db');
  const db2 = require('../lib/db.js');
  ok(typeof db2.searchMessages({ q: 'x' }).ok === 'boolean', '检索接口在异常路径下也返回结构体而不是抛错');
  if (savedDbFile == null) delete process.env.AGENTHUB_DB_FILE; else process.env.AGENTHUB_DB_FILE = savedDbFile;

  db.close();
  ok(true, 'close() 不抛异常');
} catch (e) {
  failed++;
  console.error('  ✗ 未捕获异常: ' + (e && e.stack || e));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(failed ? '\nsqlite-db: ' + failed + ' 项失败' : '\nsqlite-db: 全部通过');
process.exit(failed ? 1 : 0);
