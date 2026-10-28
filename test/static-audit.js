// 静态一致性审计（不需要起服务）：
//  1) CSS：花括号平衡；var(--x) 必须在 CSS、JS 内联 style 或 setProperty 里被定义；
//     每个主题块都应声明核心变量（避免某个主题少给变量导致颜色/边框失效）。
//  2) DOM：$('#id') / getElementById('id') 引用的元素必须存在于 index.html，或由 JS
//     动态创建（模板串 id="x"、id='x'、.id = 'x'、createElement 后赋值）——用于抓
//     拼错的 selector（那种错会让功能静默失效）。
//  3) index.html：重复 id。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('public/index.html');
// Follow the files actually loaded by the page, so a new feature module cannot
// silently fall outside the DOM and CSS checks. Third-party vendor assets have
// their own resource/presentation checks and are not application source.
const localFiles = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["'](\/[^"']+)["'][^>]*>/gi)]
  .map(m => m[1].split(/[?#]/, 1)[0])
  .filter(url => !url.startsWith('/vendor/') && /^\/[A-Za-z0-9_/-]+\.(?:js|css)$/.test(url))
  .map(url => 'public' + url);
const cssFiles = [...new Set(localFiles.filter(file => file.endsWith('.css')))];
const jsFiles = [...new Set(localFiles.filter(file => file.endsWith('.js')))];
const css = cssFiles.map(read).join('\n');
const js = jsFiles.map(read).join('\n');
const serverJs = read('server.js');

let failed = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.error('  ✗ ' + label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); }
};

// ---------- 1. CSS ----------
const openBraces = (css.match(/\{/g) || []).length;
const closeBraces = (css.match(/\}/g) || []).length;
ok(openBraces === closeBraces, 'CSS 花括号平衡', { openBraces, closeBraces });

// 定义来源：CSS 声明 + JS/HTML 内联 style（含模板串）+ setProperty
const defined = new Set();
for (const m of css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) defined.add(m[1]);
for (const m of js.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) defined.add(m[1]);              // style="--x:..." / 模板串
for (const m of js.matchAll(/setProperty\(\s*['"](--[A-Za-z0-9_-]+)/g)) defined.add(m[1]);
for (const m of html.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) defined.add(m[1]);

// 使用：var(--x) 后必须紧跟 , 或 )，避免 --acc 前缀撞上 --accent
const used = new Map();
const useRe = /var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])/g;
for (const src of [css, js]) {
  for (const m of src.matchAll(useRe)) {
    if (m[2] === ')') used.set(m[1], '<no-fallback>');
    else if (!used.has(m[1])) used.set(m[1], '');
  }
}
// 只有「无回退值」的变量才必须被定义；带回退值的变量即使没定义也能正常降级
const mustDefine = [...used.entries()].filter(([, note]) => note === '<no-fallback>').map(([v]) => v);
const missing = mustDefine.filter(v => !defined.has(v));
ok(missing.length === 0, 'var(--x) 无回退值时必须已定义（CSS / 内联 style / setProperty）', missing);

// 每个主题块（声明 --bg 的块）都应给出核心变量
const THEME_KEYS = ['--bg', '--panel', '--text', '--muted', '--accent', '--border'];
const themeBlocks = [...css.matchAll(/([^{}]+)\{([^{}]*--bg\s*:[^{}]*)\}/g)]
  .map(m => ({ sel: m[1].trim().split('\n').pop().trim(), body: m[2] }))
  .filter(t => /theme|:root/i.test(t.sel));
ok(themeBlocks.length >= 8, `主题/根块数量合理（${themeBlocks.length} 个）`, themeBlocks.length);
const themeGaps = themeBlocks
  .map(t => ({ theme: t.sel, missing: THEME_KEYS.filter(k => !new RegExp(k + '\\s*:').test(t.body)) }))
  .filter(t => t.missing.length);
ok(themeGaps.length === 0, '每个主题块都声明了核心变量', themeGaps);

// ---------- 2. DOM id ----------
const htmlIds = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
const dup = htmlIds.filter((id, i) => htmlIds.indexOf(id) !== i);
ok(dup.length === 0, 'index.html 没有重复 id', [...new Set(dup)]);

// 静态页面资源必须真的在 public/ 下存在。此前 index.html 引用了 hljs，
// 但缺少被引用的 vendor 文件，导致所有代码块都只能显示纯文本。
const publicRoot = path.resolve(ROOT, 'public');
const staticAssets = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["'](\/[^"']+)["'][^>]*>/gi)]
  .map(m => m[1].split(/[?#]/, 1)[0]);
const serverAssetRoutes = new Set([...serverJs.matchAll(/app\.get\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]));
const missingAssets = staticAssets.filter(url => {
  let decoded;
  try { decoded = decodeURIComponent(url); } catch { return true; }
  const target = path.resolve(publicRoot, '.' + decoded);
  return !target.startsWith(publicRoot + path.sep)
    || (!fs.existsSync(target) && !serverAssetRoutes.has(decoded));
});
ok(missingAssets.length === 0, 'index.html 引用的本地脚本和样式由 public 文件或显式服务路由提供', missingAssets);

const dynamicIds = new Set();
for (const m of js.matchAll(/id="([A-Za-z][A-Za-z0-9_-]*)"/g)) dynamicIds.add(m[1]);
for (const m of js.matchAll(/id='([A-Za-z][A-Za-z0-9_-]*)'/g)) dynamicIds.add(m[1]);
for (const m of js.matchAll(/\.id\s*=\s*['"]([A-Za-z][A-Za-z0-9_-]*)['"]/g)) dynamicIds.add(m[1]);
// providerSelectMarkup('npAgent', …) 这类「把 id 当参数传进去」的写法
for (const m of js.matchAll(/(?:Markup|Select|Panel|Menu|Card|Row)\(\s*['"]([A-Za-z][A-Za-z0-9_-]*)['"]/g)) dynamicIds.add(m[1]);

const referenced = new Set();
for (const m of js.matchAll(/\$\('#([A-Za-z][A-Za-z0-9_-]*)'\)/g)) referenced.add(m[1]);
for (const m of js.matchAll(/getElementById\(\s*'([A-Za-z][A-Za-z0-9_-]*)'\s*\)/g)) referenced.add(m[1]);
const staticIds = new Set(htmlIds);
const missingIds = [...referenced].filter(id => !staticIds.has(id) && !dynamicIds.has(id));
ok(missingIds.length === 0, "$('#id') 引用都能解析（静态 HTML 或 JS 动态创建）", missingIds);

console.log(`\n[static-audit] 页面源文件 ${jsFiles.length} JS / ${cssFiles.length} CSS；CSS 变量 ${defined.size} 个定义 / ${used.size} 个被引用；主题块 ${themeBlocks.length} 个；DOM ${staticIds.size} 静态 + ${dynamicIds.size} 动态 id / ${referenced.size} 处引用`);
if (failed) { console.error(`[static-audit] ${failed} 项失败`); process.exitCode = 1; }
else console.log('[static-audit] passed');
