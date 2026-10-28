// 命令幂等回执（INVARIANTS A2 的服务端半边）。
// 客户端每次发送生成一个 qid，服务端把「已受理 / 已完成 / 失败」持久化：
// 同一会话同一 qid 重复到达（多标签页、断线重发、代理重试）不会起第二个回合，
// 直接回执 duplicate。失败状态允许重试（不掩盖真实失败，见 A2 的语义）。
const { Store } = require('./store');

const MAX_ITEMS = 2000;
const store = new Store('command-receipts', { items: {} });
if (!store.data || typeof store.data !== 'object' || Array.isArray(store.data)) store.data = {};
if (!store.data.items || typeof store.data.items !== 'object' || Array.isArray(store.data.items)) store.data.items = {};

const keyOf = (sessionId, qid) => String(sessionId) + '|' + String(qid);

// 本进程启动时刻：早于它的 accepted 记录必然属于已经死掉的进程。
const PROCESS_STARTED_AT = Date.now();

function get(sessionId, qid) {
  return store.data.items[keyOf(sessionId, qid)] || null;
}

function accept(sessionId, qid) {
  const key = keyOf(sessionId, qid);
  const cur = store.data.items[key];
  // accepted 同时表示「本进程正在跑」和「某个已经崩掉的进程留下的」。后者会永久
  // 挡住同一个 qid：客户端重发只拿到 duplicate，消息被静默吞掉、回合永远不起。
  // 早于本进程启动时间的 accepted 不可能属于当前进程，按可重试处理（H1）。
  const staleAccepted = cur && cur.status === 'accepted' && Number(cur.acceptedAt) < PROCESS_STARTED_AT;
  if (cur && cur.status !== 'failed' && !staleAccepted) return { duplicate: true, status: cur.status, acceptedAt: cur.acceptedAt };
  const now = Date.now();
  store.data.items[key] = { sessionId: String(sessionId), qid: String(qid), status: 'accepted', acceptedAt: now, updatedAt: now };
  const keys = Object.keys(store.data.items);
  if (keys.length > MAX_ITEMS) {
    keys.sort((a, b) => (store.data.items[a].updatedAt || 0) - (store.data.items[b].updatedAt || 0));
    for (const k of keys.slice(0, keys.length - MAX_ITEMS)) delete store.data.items[k];
  }
  store.save();
  return { duplicate: false, status: 'accepted', acceptedAt: now };
}

function finish(sessionId, qid, status) {
  const cur = get(sessionId, qid);
  if (!cur) return null;
  cur.status = status === 'failed' ? 'failed' : 'done';
  cur.updatedAt = Date.now();
  store.save();
  return cur;
}

module.exports = { accept, finish, get };
