const { Store } = require('./store');
const store = new Store('agent-runtime', { sessions: {} });
function get(id) { return store.data.sessions?.[id] || {}; }
function update(id, value) {
  if (!id) return;
  const sessions = { ...store.data.sessions, [id]: { ...get(id), ...value, updatedAt: Date.now() } };
  const keys = Object.keys(sessions).sort((a, b) => sessions[b].updatedAt - sessions[a].updatedAt);
  store.data.sessions = Object.fromEntries(keys.slice(0, 2000).map(k => [k, sessions[k]]));
  store.save();
}
function remove(id) { delete store.data.sessions[id]; store.save(); }
module.exports = { get, update, remove };
