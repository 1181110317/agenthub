// 退出刷盘：store.save() 有 200ms 防抖，进程被停时定时器随之消失。
// 校验 flushAllStores() 能在防抖窗口内把最后一次改动落盘，以及 server.js 确实挂了处理器。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-flush-'));
process.env.AGENTHUB_DATA_DIR = dir;
const { Store, flushAllStores } = require('../lib/store.js');

let failed = 0;
const ok = (cond, label) => { if (cond) console.log('  ✓ ' + label); else { failed++; console.error('  ✗ ' + label); } };

try {
  const store = new Store('sessions', { sessions: [] });
  store.data.sessions.push({ id: 'last-write', title: '防抖窗口内的改动' });
  store.save();
  const file = path.join(dir, 'sessions.json');
  ok(!fs.existsSync(file), 'save() 之后 200ms 内尚未写盘（确认防抖存在）');
  flushAllStores();
  ok(fs.existsSync(file), 'flush 后文件已落盘');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(saved.sessions.some(s => s.id === 'last-write'), 'flush 写入的是最后一次改动');

  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(/process\.on\('exit',\s*flushStoresOnExit\)/.test(src), "server.js 注册了 exit 刷盘");
  ok(/for \(const sig of \[[^\]]*'SIGINT'[^\]]*\][\s\S]{0,120}flushStoresOnExit\(\)/.test(src), 'server.js 在 SIGINT/TERM/HUP 前刷盘');

  // saveNow 必须把成败告诉调用方：删会话要靠它决定「能不能再去删正文文件」，
  // 吞掉异常就会留下「索引说还在、磁盘上正文已经没了」的空壳会话。
  ok(store.saveNow() === true, '写盘成功时 saveNow 返回 true');
  fs.writeFileSync(path.join(dir, 'blocker'), '这是一个文件，不是目录');
  const stuck = new Store('blocker/stuck', { x: 1 });
  ok(stuck.saveNow() === false, '写不进去时 saveNow 返回 false 而不是静默');
  ok(fs.existsSync(file), '一个 store 写失败不影响别的文件');
} catch (e) {
  failed++;
  console.error('  ✗ 未捕获异常: ' + (e && e.stack || e));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(failed ? `store-flush FAILED（${failed} 项）` : 'store-flush passed');
  process.exit(failed ? 1 : 0);
}
