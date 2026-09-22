// Read-only summary of file operations recorded in local sessions.
// Git status remains the source of truth for current changes: an agent event
// records an attempted file operation, not ownership of today's diff.
const path = require('path');

function within(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function collectProjectChanges(root, sessions, expandCwd = value => value) {
  const base = path.resolve(root);
  const related = [];
  const byFile = new Map();
  for (const session of sessions || []) {
    if (!session || session.remoteHostId || !session.cwd) continue;
    let cwd;
    try { cwd = path.resolve(expandCwd(session.cwd)); } catch { continue; }
    if (!within(base, cwd)) continue;
    const touched = new Set();
    let operations = 0;
    for (const message of session.messages || []) {
      if (!message || message.role !== 'assistant') continue;
      for (const file of message.files || []) {
        if (!file || typeof file.path !== 'string' || !file.path.trim()) continue;
        const absolute = path.resolve(cwd, file.path);
        if (!within(base, absolute)) continue;
        const relative = path.relative(base, absolute).replace(/\\/g, '/');
        if (!relative) continue;
        operations++;
        touched.add(relative);
        const ts = Number(message.ts) || Number(session.updatedAt) || 0;
        const prior = byFile.get(relative);
        if (!prior || ts >= prior.ts) byFile.set(relative, {
          path: relative, sessionId: session.id, sessionTitle: session.title || '未命名会话',
          agent: session.agent || '', ts,
        });
      }
    }
    related.push({
      id: session.id, title: session.title || '未命名会话', agent: session.agent || '',
      updatedAt: Number(session.updatedAt) || 0, operations, fileCount: touched.size,
      archived: session.archived === true,
    });
  }
  related.sort((a, b) => b.updatedAt - a.updatedAt);
  const files = [...byFile.values()].sort((a, b) => b.ts - a.ts);
  return {
    sessionCount: related.length, fileCount: files.length,
    operationCount: related.reduce((sum, item) => sum + item.operations, 0),
    sessions: related.slice(0, 20), files: files.slice(0, 200),
  };
}

module.exports = { collectProjectChanges };
