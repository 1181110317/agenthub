// 服务日志环形缓冲（T5-1 诊断页）：包装 console.log/warn/error——原样透传
// 到 stdout 的同时进内存环形缓冲，诊断接口直接回尾部，不必依赖外部重定向。
// 上限：500 条 × 单条 2000 字符（超长截断），三条通道合并按到达序存放。
const MAX_LINES = 500;
const MAX_LINE_CHARS = 2000;

const lines = []; // { ts, level, text }
let seq = 0;

function fmt(args) {
  return args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ').slice(0, MAX_LINE_CHARS);
}

function push(level, args) {
  lines.push({ ts: Date.now(), level, text: fmt(args) });
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  seq++;
}

// Node 的 node:sqlite 会在启动时把 ExperimentalWarning 走到
// console.error。它仍然应该出现在诊断日志里，但不能把一次正常启动
// 误报成“服务有错误”。真正的运行时异常仍保持 error 级别。
function normalizeLevel(level, args) {
  if (level === 'error' && args.some(a => /ExperimentalWarning/i.test(String(a || '')))) return 'warn';
  return level;
}

const orig = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

console.log = (...args) => { push('info', args); orig.log(...args); };
console.warn = (...args) => { push('warn', args); orig.warn(...args); };
console.error = (...args) => { push(normalizeLevel('error', args), args); orig.error(...args); };

// tail=尾部条数；level 过滤可选
function tail(n = 200, level = '') {
  const count = Math.max(1, Math.min(Number(n) || 200, MAX_LINES));
  let out = lines.slice(-count);
  if (level) out = out.filter(l => l.level === level);
  return { total: seq, lines: out };
}

function stats() {
  return { lines: lines.length, dropped: Math.max(0, seq - lines.length), errors: lines.filter(l => l.level === 'error').length };
}

module.exports = { tail, stats };
