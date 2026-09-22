// 前后端契约一致性测试：两件事各自被抄了太多份，改一处忘别处的代价已经付过——
//
// 1) 可预览格式。服务端 /api/fs/raw 按 IMAGE_EXT|DOC_EXT|TEXT_EXT|AUDIO_EXT 决定收不
//    收某个扩展名，前端按自己的列表决定给不给预览入口。两边各写一份时，要么点了按钮
//    拿到 400「不支持预览该文件格式」，要么明明能预览却不显示按钮——Word 点开是乱码、
//    图片不显示那几次就是这么来的。
// 2) 推理档位。请求层认的档位、会话记录校验的档位、下拉框里的档位必须是同一份，
//    否则能存下一个发不出去的值，用户选了却什么都没发生。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { REASONING_LEVELS } = require('../lib/model-capabilities');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

let failed = 0;
const ok = (cond, label) => { if (cond) console.log('  ✓ ' + label); else { failed++; console.error('  ✗ ' + label); } };

// 扩展名正则里没有 '/'，可以直接按字面量抓出来重建成 RegExp
const serverExt = {};
for (const m of serverSrc.matchAll(/const (IMAGE_EXT|DOC_EXT|TEXT_EXT|AUDIO_EXT|IMAGE_STREAM_EXT) = \/([^/]+)\/i;/g)) {
  serverExt[m[1]] = new RegExp(m[2], 'i');
}
for (const key of ['IMAGE_EXT', 'DOC_EXT', 'TEXT_EXT', 'AUDIO_EXT', 'IMAGE_STREAM_EXT']) {
  assert.ok(serverExt[key], 'server.js 里没找到 ' + key + '，这个测试需要同步更新');
}
const serverAccepts = name => ['IMAGE_EXT', 'DOC_EXT', 'TEXT_EXT', 'AUDIO_EXT'].some(k => serverExt[k].test(name));

const appArr = {};
for (const m of appSrc.matchAll(/const (EXT_IMAGE|EXT_OFFICE|EXT_TEXT|EXT_AUDIO) = \[([^\]]*)\];/g)) {
  appArr[m[1]] = (m[2].match(/'([^']+)'/g) || []).map(x => x.slice(1, -1));
}
for (const key of ['EXT_IMAGE', 'EXT_OFFICE', 'EXT_TEXT', 'EXT_AUDIO']) {
  assert.ok(Array.isArray(appArr[key]) && appArr[key].length, 'public/app.js 里没找到 EXT 数组 ' + key);
}
// 前端三个判定都必须是这几个数组的派生（同一份列表不许再手抄第二遍）
const extRegExp = list => new RegExp('\\.(?:' + list.join('|') + ')$', 'i');
const frontDoc = appSrc.match(/const DOC_PREVIEW_EXT = extRegExp\(\[([^\]]*)\]\)/);
const frontFile = appSrc.match(/const FILE_PREVIEW_EXT = extRegExp\(\[([^\]]*)\]\)/);
assert.ok(frontDoc && frontFile, '前端的预览判定必须由 extRegExp([...]) 派生');
const listsOf = decl => decl[1].split(',').map(raw => {
  const key = raw.trim();
  assert.ok(Array.isArray(appArr[key]), '未知扩展名集合 ' + key);
  return appArr[key];
}).flat();
const FRONT_DOC = listsOf(frontDoc).flat();
const FRONT_FILE = [...listsOf(frontFile).flat()];
const FRONT_ALL = [...appArr.EXT_OFFICE, ...appArr.EXT_TEXT, ...appArr.EXT_AUDIO, ...appArr.EXT_IMAGE];

// 1. 前端给出预览入口的每一个扩展名，服务端都必须接受（否则点了就是 400）
const rejected = FRONT_FILE.filter(e => !serverAccepts('x.' + e));
ok(rejected.length === 0, '前端可预览的扩展名服务端全部接受' + (rejected.length ? '，被拒：' + rejected.join(',') : ''));

// 2. 图片之外可预览的必须走「预览」，图片走「查看」：两个分支加起来要等于全表，
//    否则有的文件卡片两个按钮都没有。
const missingEntry = FRONT_FILE.filter(e => !extRegExp(FRONT_DOC).test('x.' + e) && !extRegExp(appArr.EXT_IMAGE).test('x.' + e));
ok(missingEntry.length === 0, '文件卡片对每种可预览格式都有入口' + (missingEntry.length ? '，漏：' + missingEntry.join(',') : ''));
ok(extRegExp(FRONT_FILE).source === extRegExp(FRONT_ALL).source, 'FILE_PREVIEW_EXT 就是四类集合的并集，没多抄也没漏抄');

// 3. svg 必须留在 IMAGE_EXT（可以预览）但不能进 IMAGE_STREAM_EXT（同源直出 = 把
//    脚本执行交给文件内容）。这条钉住，避免有人「补齐」表格时顺手把 svg 加回流式表。
ok(serverExt.IMAGE_EXT.test('a.svg') && !serverExt.IMAGE_STREAM_EXT.test('a.svg'), 'svg 可预览但不走同源流式（XSS 防线）');
const streamGap = appArr.EXT_IMAGE.filter(e => e !== 'svg' && !serverExt.IMAGE_STREAM_EXT.test('x.' + e));
ok(streamGap.length === 0, '除 svg 外的图片都能走流式' + (streamGap.length ? '，缺：' + streamGap.join(',') : ''));

// 4. 服务端比前端多认的那些（源码类，消息里本来就内联显示）要维持在已知清单内：
//    再往外扩就意味着「能读但界面上没入口」，得同步决定要不要给按钮。
const SERVER_ONLY = ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'less', 'vue', 'svelte',
  'py', 'java', 'go', 'rs', 'rb', 'php', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'sh', 'bash', 'zsh',
  'bat', 'cmd', 'ps1', 'sql', 'toml', 'lock'];
const extras = new Set();
for (const probe of SERVER_ONLY.concat(['asm', 'swift', 'kt', 'dif', 'patch', 'ipynb'])) {
  if (serverAccepts('x.' + probe) && !FRONT_ALL.includes(probe)) extras.add(probe);
}
const unknownExtras = [...extras].filter(e => !SERVER_ONLY.includes(e));
ok(unknownExtras.length === 0, '服务端没有悄悄多出前端不认识的格式' + (unknownExtras.length ? '：' + unknownExtras.join(',') : ''));
ok(extras.size > 0 && FRONT_ALL.every(e => serverAccepts('x.' + e)), '服务端额外认源码类扩展名，前端仍在其子集内');

// ---- 推理档位 ----
const sameList = list => JSON.stringify(list) === JSON.stringify([...REASONING_LEVELS]);
ok(/const EFFORT_LEVELS = modelCapabilities\.REASONING_LEVELS/.test(serverSrc), 'server.js 的档位表引用唯一来源，没有再抄一份');
ok(/REASONING_LEVELS: EFFORT_LEVELS/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'api-agent.js'), 'utf8')),
  'api-agent.js 的档位表同样引用唯一来源');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const sel = html.match(/<select id="selEffort"[\s\S]*?<\/select>/);
assert.ok(sel, 'index.html 里找不到 #selEffort');
ok(sameList([...sel[0].matchAll(/<option value="([a-z]+)"[^>]*>/g)].map(m => m[1])), '聊天输入框的档位选项与唯一来源同序同集');

const optBlock = appSrc.match(/const effortOptions = \[([\s\S]*?)\n  \];/);
assert.ok(optBlock, 'app.js 里找不到 effortOptions');
ok(sameList([...optBlock[1].matchAll(/\['([a-z]+)',/g)].map(m => m[1])), '供应商设置里的默认推理档位与唯一来源同序同集');

const labelBlock = appSrc.match(/const effortLabel = value => \(\{([\s\S]*?)\}\[value\]/);
assert.ok(labelBlock, 'app.js 里找不到 effortLabel');
ok(sameList([...labelBlock[1].matchAll(/([a-z]+):/g)].map(m => m[1])), '档位中文名覆盖且仅覆盖唯一来源里的那些档位');

console.log(failed ? `front-back-contract FAILED（${failed} 项）` : 'front-back-contract passed');
process.exit(failed ? 1 : 0);
