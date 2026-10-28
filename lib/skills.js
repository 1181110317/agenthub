const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

async function inventory(cwd, disabled = []) {
  const home = os.homedir();
  const roots = [
    ...(cwd ? ['.claude', '.agents', '.codex'].map(x => ({ root: path.join(cwd, x, 'skills'), scope: 'project', source: x.slice(1) })) : []),
    { root: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills'), scope: 'global', source: 'claude' },
    { root: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'skills'), scope: 'global', source: 'codex' },
    { root: path.join(home, '.agents', 'skills'), scope: 'global', source: 'agents' },
  ];
  const off = new Set(disabled);
  const seen = new Set();
  const skills = [];
  for (const r of roots) {
    let entries;
    try { entries = await fs.readdir(r.root, { withFileTypes: true }); } catch { continue; }
    for (const it of entries) {
      if (!it.isDirectory() || seen.has(it.name) || !/^[A-Za-z0-9._-]{1,160}$/.test(it.name)) continue;
      const file = path.join(r.root, it.name, 'SKILL.md');
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > 128 * 1024) continue;
        const real = await fs.realpath(file);
        const raw = await fs.readFile(real, 'utf8');
        const desc = /^description:\s*(.+)$/m.exec(raw)?.[1]?.trim().replace(/^["']|["']$/g, '').slice(0, 240) || '';
        seen.add(it.name);
        skills.push({ name: it.name, description: desc, scope: r.scope, source: r.source, path: real, enabled: !off.has(it.name) });
      } catch { continue; }
      if (skills.length >= 80) break;
    }
    if (skills.length >= 80) break;
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function prepare(session, disabled, prompt = '') {
  if (session.remoteHostId || session.agent === 'chatgpt-web') return { prompt: '', skills: [], nativePolicy: [], hash: '' };
  const all = await inventory(session.cwd || require('./workspace').defaultWorkspaceDir(), disabled);
  const selected = Array.isArray(session.skillSelection) ? new Set(session.skillSelection) : null;
  const mentioned = new Set([...String(prompt).matchAll(/(?:^|\s)[$/]([A-Za-z0-9._-]{1,160})(?=\s|$)/g)].map(m => m[1]));
  const skills = all.filter(s => s.enabled && (!selected || selected.has(s.name)));
  let text = '';
  if (skills.length) {
    text = 'AgentHub 本轮可用技能（仅在与任务相关时使用，先读取对应 SKILL.md；用户明确要求优先于技能说明）：\n' + skills.map(s => '- ' + s.name + ': ' + s.description + '\n  SKILL.md: ' + s.path).join('\n');
    let budget = 64 * 1024;
    for (const s of skills.filter(s => mentioned.has(s.name) || selected?.has(s.name)).slice(0, 8)) {
      let raw;
      try { raw = await fs.readFile(s.path, 'utf8'); }
      catch { text += '\n技能 ' + s.name + ' 已不可读取，本轮跳过。'; continue; }
      if (raw.length > budget) { text += '\n技能 ' + s.name + ' 正文较长，请按路径读取。'; continue; }
      text += '\n\n[技能 ' + s.name + '，来源 ' + s.path + ']\n' + raw;
      budget -= raw.length;
    }
  }
  const nativePolicy = all.map(s => ({ name: s.name, path: s.path, enabled: s.enabled && (!selected || selected.has(s.name)) }));
  return { prompt: text, skills, nativePolicy, hash: crypto.createHash('sha256').update(text + JSON.stringify(nativePolicy)).digest('hex') };
}
function selection(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 80 || value.some(n => typeof n !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(n))) throw new Error('技能选择无效');
  return [...new Set(value)];
}
module.exports = { inventory, prepare, selection };
