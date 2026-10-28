// 文档漂移防护（doc-lint）。
//
// 起因：这个仓库的文档曾经落后于代码——`agent.md` 写「32 个脚本」而实际是 65；
// README 写「7 套主题」而 `public/app.js` 里有 10 套、名字也对不上；
// 对比文档里的「14 个 MCP 工具」在加了两个工具之后就错了。
// 这类漂移不会让测试变红，却会让下一次「读文档做判断」的结论全部跑偏。
//
// 这里只校验**代码拥有的事实**，且只校验**活跃文档**：
//   - README.md / README.zh.md / agent.md / FEATURES.zh.md / FEATURES-NEXT.md
//     / INVARIANTS.md / AIONUI-COMPARISON.zh.md
// 带日期的历史记录（HANDOFF-YYYY-MM-DD.md、TEST-AUDIT-*.md、T3CODE-COMPARISON.zh.md
// 的「实施记录」章节）按性质就是快照，不参与校验。
//
// 再加两条代码↔代码契约：测试脚本必须都挂在 npm test 链上、每个主题都要有配色块。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

// 活跃文档：会被当作「当前事实」引用的那些。
// 带日期的记录（HANDOFF-YYYY-MM-DD.md、TEST-AUDIT-*.md、T3CODE-COMPARISON.zh.md、
// AIONUI-COMPARISON.zh.md）按性质是某一轮的快照，不参与「当前事实」校验。
const LIVING_DOCS = ['README.md', 'README.zh.md', 'agent.md', 'FEATURES.zh.md', 'FEATURES-NEXT.md', 'INVARIANTS.md'];

const checks = [];
function check(name, fn) {
  try { fn(); checks.push('PASS ' + name); console.log('  PASS ' + name); }
  catch (e) { checks.push('FAIL ' + name); console.error('  FAIL ' + name + ': ' + (e && e.message || e)); process.exitCode = 1; }
}

const pkg = JSON.parse(read('package.json'));
const chain = String(pkg.scripts.test).split('&&').map(s => s.trim()).filter(Boolean);

// ---------- 源码事实 ----------
const testFiles = fs.readdirSync(path.join(ROOT, 'test'))
  .filter(f => f.endsWith('.js'))
  // 手动验证脚本（需要真实外部凭据/花钱，刻意不挂链）：env 门控，列出即文档
  .filter(f => !['image-gen-real.js', 'image-gen-split.js'].includes(f))
  .map(f => 'test/' + f)
  .sort();
const chainFiles = chain.filter(c => /^node\s+test\//.test(c)).map(c => c.replace(/^node\s+/, '')).sort();

const appJs = read('public/app.js');
// 只在 `const THEMES = [...]` 这个数组里找主题，避免把别处的 { id, name } 对象也算进来
const themeBlock = (() => {
  const start = appJs.indexOf('const THEMES = [');
  assert(start >= 0, 'public/app.js 里找不到 THEMES 数组');
  const end = appJs.indexOf('];', start);
  assert(end > start, 'THEMES 数组没有正常的结束标记');
  return appJs.slice(start, end);
})();
const THEMES = [...themeBlock.matchAll(/\{\s*id:\s*'([a-z0-9-]+)',\s*name:\s*'([^']+)'/g)].map(m => ({ id: m[1], name: m[2] }));
const workspaceCss = read('public/workspace.css');
const mcpTools = require('../lib/mcp-tools');
const mcpCount = mcpTools.TOOLS.length;
const AGENT_DEFS = require('../lib/agents.js').DEFS;

const docs = {};
for (const d of LIVING_DOCS) {
  try { docs[d] = read(d); } catch { docs[d] = null; }
}

// ---------- 1. 代码↔代码 ----------
check('npm test 链与 test/*.js 完全一致（不漏挂，也不留幽灵脚本）', () => {
  assert(testFiles.length > 0);
  const missing = testFiles.filter(f => !chainFiles.includes(f));
  const ghost = chainFiles.filter(f => !testFiles.includes(f));
  assert.deepEqual(missing, [], '有测试文件没挂进 npm test：' + missing.join(', '));
  assert.deepEqual(ghost, [], 'npm test 里引用了不存在的脚本：' + ghost.join(', '));
});

check('每个主题都有对应的配色块（THEMES ↔ workspace.css）', () => {
  assert(THEMES.length >= 2, 'THEMES 解析数量异常：' + THEMES.length);
  const missing = THEMES.filter(t => !workspaceCss.includes('body[data-theme="' + t.id + '"]'));
  assert.deepEqual(missing.map(t => t.id), [], 'THEMES 里有主题缺少 CSS 配色块');
});

check('注入型 MCP 工具注册表自洽（TOOLS / TOOL_NAMES / TOOL_MAP 数量一致）', () => {
  assert.equal(mcpTools.TOOL_NAMES.length, mcpCount);
  assert.equal(mcpTools.TOOL_MAP.size, mcpCount); // TOOL_MAP 是 Map，不是普通对象
  assert(mcpCount > 0);
});

// ---------- 2. 文档里由代码拥有的数字 ----------
const docList = Object.entries(docs).filter(([, text]) => text);

check(`活跃文档里的「N 个脚本」必须等于 ${testFiles.length}`, () => {
  const bad = [];
  for (const [file, text] of docList) {
    text.split('\n').forEach((line, i) => {
      const m = /(\d+)\s*(?:个(?:测试)?脚本|(?:registered\s+)?scripts\b)/i.exec(line);
      if (m && Number(m[1]) !== testFiles.length) bad.push(`${file}:${i + 1} 写的是 ${m[1]} 个脚本（实际 ${testFiles.length}）`);
    });
  }
  assert.deepEqual(bad, [], bad.join('；'));
});

check(`活跃文档里的「N 套主题」必须等于 ${THEMES.length}，且主题名要能对上`, () => {
  const bad = [];
  let sawThemeCount = false;
  for (const [file, text] of docList) {
    text.split('\n').forEach((line, i) => {
      const m = /(\d+)\s*(?:套主题|themes\b|palettes\b)/i.exec(line);
      if (!m) return;
      sawThemeCount = true;
      if (Number(m[1]) !== THEMES.length) bad.push(`${file}:${i + 1} 写的是 ${m[1]} 套主题（实际 ${THEMES.length}）`);
    });
  }
  assert(sawThemeCount, '没有任何文档声明主题数量——要么补上，要么把这条检查删掉（别让它悄悄失效）');
  // Local Chinese notes are optional; a clean checkout validates the published
  // English README against canonical IDs instead of requiring ignored files.
  const chinese = docs['README.zh.md'];
  const readme = chinese || docs['README.md'] || '';
  const themeLine = readme.split('\n').find(l => chinese ? /套主题/.test(l) : /\d+\s*(?:themes|palettes)\b/i.test(l));
  assert(themeLine, 'README 里找不到主题清单行');
  const missing = THEMES.filter(t => chinese ? !themeLine.includes(t.name) : !themeLine.includes('`'+t.id+'`')).map(t => chinese?t.name:t.id);
  assert.deepEqual(missing, [], 'README.zh.md 的主题清单缺少：' + missing.join('、'));
  assert.deepEqual(bad, [], bad.join('；'));
});

check(`活跃文档里的「N 个 MCP 工具」必须等于 ${mcpCount}`, () => {
  const bad = [];
  for (const [file, text] of docList) {
    text.split('\n').forEach((line, i) => {
      const m = /(\d+)\s*个\s*MCP\s*工具/.exec(line);
      if (m && Number(m[1]) !== mcpCount) bad.push(`${file}:${i + 1} 写的是 ${m[1]} 个（实际 ${mcpCount}）`);
    });
  }
  assert.deepEqual(bad, [], bad.join('；'));
});

check('agent.md / README 提到的内置 Agent 数量与 lib/agents.js 的 DEFS 一致', () => {
  const declared = Object.keys(AGENT_DEFS).length;
  assert(declared > 0, 'lib/agents.js 的 DEFS 为空');
  for (const [file, text] of docList) {
    text.split('\n').forEach((line, i) => {
      const m = /(\d+)\s*个(?:原生\/)?内置 Agent/.exec(line);
      if (m && Number(m[1]) !== declared) throw new Error(`${file}:${i + 1} 写的是 ${m[1]} 个（lib/agents.js 实际 ${declared}）`);
    });
  }
});

const failed = checks.filter(c => c.startsWith('FAIL')).length;
console.log(`\n[doc-lint] ${checks.length - failed}/${checks.length} checks passed（活跃文档 ${docList.length} 份；测试脚本 ${testFiles.length}；主题 ${THEMES.length}；MCP 工具 ${mcpCount}）`);
