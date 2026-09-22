'use strict';

// Explicit, persistent "always allow" grants.  A grant is deliberately scoped
// to one project, one Agent and one tool: it must never turn an approval made in
// one workspace into a blanket approval for another workspace.
const path = require('path');
const { Store } = require('./store');
const { defaultWorkspaceDir } = require('./workspace');

const MAX_PROJECTS = 256;
const MAX_TOOLS_PER_PROJECT = 128;
const memoryStore = new Store('permission-memory', { version: 1, projects: {} });

function text(value, max = 256) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function agentKey(value) {
  const out = text(value, 128);
  return /^[A-Za-z0-9:_-]{1,128}$/.test(out) ? out : '';
}

function toolKey(value) {
  const out = text(value, 128).toLowerCase();
  return out && !/[\0\r\n]/.test(out) ? out : '';
}

function projectKey(cwd, remoteHostId) {
  const host = text(remoteHostId || 'local', 256).toLowerCase() || 'local';
  const raw = text(cwd, 4096) || defaultWorkspaceDir();
  let canonical = raw;
  if (host === 'local') {
    try { canonical = path.resolve(raw); } catch {}
    canonical = path.normalize(canonical);
    if (process.platform === 'win32') canonical = canonical.toLowerCase();
  } else if (raw.startsWith('/')) {
    canonical = path.posix.normalize(raw);
  } else {
    canonical = raw.replace(/[\\/]+/g, '/').replace(/\/\.$/, '');
  }
  // A root path should not lose its separator; other paths get one stable form.
  if (canonical.length > 1) canonical = canonical.replace(/[\\/]$/, '');
  return host + '::' + canonical.slice(0, 4096);
}

function sessionProject(session) {
  const s = session || {};
  return projectKey(s.cwd, s.remoteHostId);
}

function normalizeData() {
  const source = memoryStore.data && typeof memoryStore.data === 'object' && !Array.isArray(memoryStore.data)
    ? memoryStore.data : { version: 1, projects: {} };
  const projects = {};
  const entries = source.projects && typeof source.projects === 'object' && !Array.isArray(source.projects)
    ? Object.entries(source.projects) : [];
  for (const [project, agents] of entries.slice(0, MAX_PROJECTS)) {
    if (!project || !agents || typeof agents !== 'object' || Array.isArray(agents)) continue;
    const cleanAgents = {};
    for (const [agent, tools] of Object.entries(agents)) {
      const a = agentKey(agent);
      if (!a || !tools || typeof tools !== 'object' || Array.isArray(tools)) continue;
      const cleanTools = {};
      for (const [tool, value] of Object.entries(tools).slice(0, MAX_TOOLS_PER_PROJECT)) {
        const t = toolKey(tool);
        if (!t) continue;
        const at = Number(value && value.at) || Date.now();
        cleanTools[t] = { at: Math.max(0, at) };
      }
      if (Object.keys(cleanTools).length) cleanAgents[a] = cleanTools;
    }
    if (Object.keys(cleanAgents).length) projects[String(project).slice(0, 4200)] = cleanAgents;
  }
  memoryStore.data = { version: 1, projects };
}

normalizeData();

function allows(session, tool) {
  const project = sessionProject(session);
  const agent = agentKey(session && session.agent);
  const name = toolKey(tool);
  return !!(project && agent && name && memoryStore.data.projects[project]
    && memoryStore.data.projects[project][agent]
    && memoryStore.data.projects[project][agent][name]);
}

function remember(session, tool) {
  const project = sessionProject(session);
  const agent = agentKey(session && session.agent);
  const name = toolKey(tool);
  if (!project || !agent || !name) return { ok: false, error: '项目或工具标识无效' };
  const projects = memoryStore.data.projects;
  if (!projects[project]) projects[project] = {};
  if (!projects[project][agent]) projects[project][agent] = {};
  projects[project][agent][name] = { at: Date.now() };
  // Bound the total number of remembered tools in a project.  This is a safety
  // valve for malformed clients; normal UI use never approaches the limit.
  const all = Object.values(projects[project]).reduce((n, tools) => n + Object.keys(tools || {}).length, 0);
  if (all > MAX_TOOLS_PER_PROJECT) {
    const rows = [];
    for (const [a, tools] of Object.entries(projects[project])) {
      for (const [t, value] of Object.entries(tools || {})) rows.push({ a, t, at: Number(value && value.at) || 0 });
    }
    rows.sort((x, y) => y.at - x.at);
    const keep = new Set(rows.slice(0, MAX_TOOLS_PER_PROJECT).map(x => x.a + '\0' + x.t));
    for (const [a, tools] of Object.entries(projects[project])) {
      for (const t of Object.keys(tools || {})) if (!keep.has(a + '\0' + t)) delete tools[t];
      if (!Object.keys(tools).length) delete projects[project][a];
    }
  }
  trimProjects();
  const persisted = memoryStore.saveNow();
  return { ok: persisted, project, agent, tool: name, at: projects[project] && projects[project][agent] && projects[project][agent][name] && projects[project][agent][name].at };
}

function revoke(session, tool) {
  const project = sessionProject(session);
  const agent = agentKey(session && session.agent);
  const name = toolKey(tool);
  const bucket = project && agent && memoryStore.data.projects[project] && memoryStore.data.projects[project][agent];
  if (!bucket || !name || !bucket[name]) return { ok: true, removed: false, project, agent, tool: name };
  delete bucket[name];
  if (!Object.keys(bucket).length) delete memoryStore.data.projects[project][agent];
  if (!Object.keys(memoryStore.data.projects[project] || {}).length) delete memoryStore.data.projects[project];
  const persisted = memoryStore.saveNow();
  return { ok: persisted, removed: true, project, agent, tool: name };
}

function list(session) {
  const project = sessionProject(session);
  const agent = agentKey(session && session.agent);
  const bucket = project && agent && memoryStore.data.projects[project] && memoryStore.data.projects[project][agent];
  return Object.entries(bucket || {}).map(([tool, value]) => ({ tool, at: Number(value && value.at) || 0 }))
    .sort((a, b) => b.at - a.at);
}

function trimProjects() {
  const projects = memoryStore.data.projects;
  const rows = Object.entries(projects).map(([project, agents]) => ({
    project,
    at: Math.max(0, ...Object.values(agents || {}).flatMap(tools => Object.values(tools || {}).map(v => Number(v && v.at) || 0))),
  })).sort((a, b) => b.at - a.at);
  for (const row of rows.slice(MAX_PROJECTS)) delete projects[row.project];
}

module.exports = {
  MAX_PROJECTS, MAX_TOOLS_PER_PROJECT,
  projectKey, sessionProject, allows, remember, revoke, list,
  _store: memoryStore,
};
