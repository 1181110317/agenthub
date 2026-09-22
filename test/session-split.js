// 消息体拆分存储回归测试（lib/session-files.js + Store 钩子，INVARIANTS B4）
// D4：必须在 require 任何 lib 模块前设置隔离数据目录，绝不触碰真实 data/
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.AGENTHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-split-test-'));

const assert = require('assert');
const { Store } = require('../lib/store');
const sessionFiles = require('../lib/session-files');

// 1. persistAll 写文件 + loadMessages 回读；冒号 id 不得出现在文件名里（NTFS 借流）
const sessions = [
  { id: 's1', messages: [{ role: 'user', text: 'hello', ts: 1 }] },
  { id: 'a:b', messages: [{ role: 'assistant', text: 'colon id', ts: 2 }] },
];
assert.strictEqual(sessionFiles.persistAll(sessions).size, 0);
assert.deepStrictEqual(sessionFiles.loadMessages('s1'), sessions[0].messages);
assert.ok(!path.basename(sessionFiles.fileFor('a:b')).includes(':'), '冒号 id 必须被替换');

// 2. 内容未变（指纹相同）不重写：外部改坏文件后 persistAll 不得重写。
//    注意这里不能调 loadMessages——按 B4 它会把 s1 标记为"读失败不可覆盖"
fs.writeFileSync(sessionFiles.fileFor('s1'), 'CORRUPTED');
sessionFiles.persistAll(sessions);
assert.strictEqual(
  fs.readFileSync(sessionFiles.fileFor('s1'), 'utf8'),
  'CORRUPTED',
  '指纹未变时不应重写文件',
);

// 3. 内容变化后重写
sessions[0].messages.push({ role: 'assistant', text: 'reply', ts: 3 });
sessionFiles.persistAll(sessions);
assert.strictEqual(sessionFiles.loadMessages('s1').length, 2);

// 4. 正文序列化抛异常 → 记入 failed，不中断其余会话
const evil = { id: 'evil' };
Object.defineProperty(evil, 'messages', { get() { throw new Error('boom'); } });
assert.strictEqual(sessionFiles.persistAll([evil]).has('evil'), true);
assert.strictEqual(sessionFiles.persistAll([...sessions, evil]).size, 1);

// 5. Store 钩子：索引 slim 化，正文进独立文件；模拟重启后索引无正文、文件可回读
let hookFailed = new Set();
const store = new Store('sessions', { sessions: [] }, {
  beforeSave(data) { hookFailed = sessionFiles.persistAll(data.sessions); },
  serialize(data) {
    return JSON.stringify({
      sessions: data.sessions.map(s => (hookFailed.has(String(s.id)) ? s : { ...s, messages: undefined })),
    }, null, 2);
  },
});
store.data.sessions = [{ id: 's2', title: '拆分会话', messages: [{ role: 'user', text: 'x', ts: 9 }] }];
store.saveNow();
assert.strictEqual(hookFailed.size, 0);
const indexRaw = JSON.parse(fs.readFileSync(store.file, 'utf8'));
assert.strictEqual(indexRaw.sessions[0].messages, undefined, '索引里不应有消息正文');
assert.deepStrictEqual(sessionFiles.loadMessages('s2'), store.data.sessions[0].messages);

// 6. removeMessages + sweepOrphans（孤儿清理不伤合法文件）
sessionFiles.removeMessages('s1');
assert.strictEqual(sessionFiles.loadMessages('s1'), null);
sessions[0].messages = [{ role: 'user', text: 'rebuilt', ts: 4 }];
sessionFiles.persistAll(sessions);
fs.writeFileSync(path.join(sessionFiles.DIR, 'orphan.json'), '[]');
// persistAll 崩溃留下的临时文件（正常写入的最后一步就是 rename）也要一起清掉，
// 否则永远留在 data/sessions 里被备份打包带走；重建临时文件是取证证据，例外保留。
fs.writeFileSync(path.join(sessionFiles.DIR, 's1.json.1234.abcd.tmp'), 'half-written');
fs.writeFileSync(path.join(sessionFiles.DIR, 's2.json.1234.rebuild.tmp'), '[]');
sessionFiles.sweepOrphans(sessions.map(s => s.id).concat('s2'));
assert.strictEqual(fs.existsSync(path.join(sessionFiles.DIR, 'orphan.json')), false, '孤儿应被清扫');
assert.strictEqual(fs.existsSync(path.join(sessionFiles.DIR, 's1.json.1234.abcd.tmp')), false, '崩溃残留的 .tmp 应被清扫');
assert.ok(fs.existsSync(path.join(sessionFiles.DIR, 's2.json.1234.rebuild.tmp')), '重建临时文件是证据，不得清扫');
assert.deepStrictEqual(sessionFiles.loadMessages('s1'), sessions[0].messages, '合法文件不得被清扫');
assert.deepStrictEqual(sessionFiles.loadMessages('a:b'), sessions[1].messages, '合法文件不得被清扫');

// 7. 损坏文件保护：读失败/损坏 → 先把原文一次性备份成 .corrupt-*.json 并读回验证，
//    然后分三种情况：内存里还是空的（刚启动没补齐）绝不覆盖；本进程没能验证出备份
//    的绝不覆盖；只有「已验证的副本存在 + 内存里确实有新消息」才放行——否则这个
//    会话之后产生的每条消息都永远落不了盘（索引剥掉正文、正文又不让写），重启后
//    新消息凭空消失，而副本一直都在磁盘上，根本没有失去什么。
const cId = 'corrupted';
sessionFiles.persistAll([{ id: cId, messages: [{ role: 'user', text: 'real data', ts: 1 }] }]);
fs.writeFileSync(sessionFiles.fileFor(cId), '{broken');
assert.strictEqual(sessionFiles.loadMessages(cId), null, '损坏文件应返回 null');
const brokenContent = fs.readFileSync(sessionFiles.fileFor(cId), 'utf8');
const backups = fs.readdirSync(sessionFiles.DIR).filter(n => n.includes('.corrupt-'));
assert.strictEqual(backups.length, 1, '损坏原文应一次性备份');
assert.strictEqual(fs.readFileSync(path.join(sessionFiles.DIR, backups[0]), 'utf8'), brokenContent, '备份必须是原文本身');
// 空正文（启动时补齐失败的样子）不得覆盖
sessionFiles.persistAll([{ id: cId, messages: [] }]);
assert.strictEqual(fs.readFileSync(sessionFiles.fileFor(cId), 'utf8'), brokenContent, '空正文不得覆盖损坏原文');
// 有新正文 + 副本已验证 → 放行，会话重新可持久化，证据仍在备份里
sessionFiles.persistAll([{ id: cId, messages: [{ role: 'user', text: 'clobber?', ts: 2 }] }]);
assert.strictEqual(sessionFiles.loadMessages(cId)[0].text, 'clobber?', '有已验证副本时新消息必须能落盘');
assert.strictEqual(fs.readFileSync(path.join(sessionFiles.DIR, backups[0]), 'utf8'), brokenContent, '覆盖之后原文仍能从备份读出');
// 没能验证出副本的（这里用目录冒充文件，readFileSync 抛 EISDIR，走不到备份那一步）
// 仍然保住现场；新消息必须记入 failed，供索引内联兜底。
const dirId = 'unreadable';
fs.mkdirSync(sessionFiles.fileFor(dirId), { recursive: true });
assert.strictEqual(sessionFiles.loadMessages(dirId), null, '读不出内容应返回 null');
assert.strictEqual(sessionFiles.persistAll([{ id: dirId, messages: [{ role: 'user', text: 'x', ts: 1 }] }]).has(dirId), true,
  '没有已验证副本时不覆盖正文，新消息必须由索引兜底');
assert.ok(fs.existsSync(sessionFiles.fileFor(dirId)), '现场必须保留');
fs.rmSync(sessionFiles.fileFor(dirId), { recursive: true, force: true });
assert.strictEqual(sessionFiles.loadMessages('never-existed'), null, '文件不存在属正常');
sessionFiles.persistAll([{ id: 'never-existed', messages: [{ role: 'user', text: 'new', ts: 1 }] }]);
assert.strictEqual(sessionFiles.loadMessages('never-existed')[0].text, 'new', '缺失文件应正常落盘');
sessionFiles.removeMessages(cId);
sessionFiles.persistAll([{ id: cId, messages: [{ role: 'user', text: 'fresh', ts: 3 }] }]);
assert.strictEqual(sessionFiles.loadMessages(cId)[0].text, 'fresh', '删除后标记解除，可重新落盘');

// 8. 「副本已验证」必须是真的验证过，不是写完就算。这里只在读回备份那一步动手脚，
//    装作备份文件里的内容跟损坏原文对不上：这时不能放行覆盖 live 文件，否则原文
//    既没保住、副本又是假的。
const vId = 'corrupt-backup-unverified';
const vFile = sessionFiles.fileFor(vId);
fs.writeFileSync(vFile, '{oops');
const realReadFileSync = fs.readFileSync;
try {
  fs.readFileSync = function (file, enc) {
    if (typeof file === 'string' && file.includes('.corrupt-') && enc === 'utf8') return 'NOT WHAT WE WROTE';
    return realReadFileSync.call(fs, file, enc);
  };
  assert.strictEqual(sessionFiles.loadMessages(vId), null, '损坏文件应返回 null');
} finally {
  fs.readFileSync = realReadFileSync;
}
sessionFiles.persistAll([{ id: vId, messages: [{ role: 'user', text: 'clobber?', ts: 2 }] }]);
assert.strictEqual(fs.readFileSync(vFile, 'utf8'), '{oops', '备份没验证成功时仍然不得覆盖 live 文件');
sessionFiles.removeMessages(vId);

console.log('session-split tests passed');
