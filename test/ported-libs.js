// 移植模块的单元测试（t3code MIT 代码的字面行为校验）：
// lib/search-ranking.js ← packages/shared/src/searchRanking.ts
// 常量与分级权重必须与原实现一致，否则「排序更深」就无从谈起。
const assert = require('assert');
const rank = require('../lib/search-ranking');

let failed = 0;
const ok = (cond, label) => {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.error('  ✗ ' + label); }
};

// ---- normalizeSearchQuery ----
ok(rank.normalizeSearchQuery('  Hello  ') === 'hello', 'normalize：去空白 + 小写');
ok(rank.normalizeSearchQuery('  @foo', { trimLeadingPattern: /^@/ }) === 'foo', 'normalize：trimLeadingPattern 去前缀');
ok(rank.normalizeSearchQuery('   ') === '', 'normalize：全空白 → 空串');

// ---- scoreSubsequenceMatch（t3code 原式：first*2 + gap*3 + span + lengthPenalty）----
const sub = rank.scoreSubsequenceMatch('abc', 'abc');
ok(sub === 0, '子序列：连续完全匹配得 0 分');
// 'a-b-c' vs 'abc'：gap=1+1 → 2*3，span=2，lengthPenalty=min(64,2)=2 → 10
const subGap = rank.scoreSubsequenceMatch('a-b-c', 'abc');
ok(subGap === 10, '子序列：间隔/跨度/长度惩罚合计 = 10（与原实现同式）');
ok(rank.scoreSubsequenceMatch('abc', 'acb') === null, '子序列：非子序列返回 null');
ok(rank.scoreSubsequenceMatch('anything', '') === 0, '子序列：空查询得 0');

// ---- scoreQueryMatch（分级：越小越靠前；注意原式 = base + 位置×2 + 长度惩罚）----
const tiers = { exactBase: 0, prefixBase: 10, boundaryBase: 20, includesBase: 30, fuzzyBase: 60 };
const exact = rank.scoreQueryMatch({ value: 'login', query: 'login', ...tiers });
const prefix = rank.scoreQueryMatch({ value: 'loginxyz', query: 'login', ...tiers });
const boundary = rank.scoreQueryMatch({ value: 'aaa-login', query: 'login', ...tiers });
const includes = rank.scoreQueryMatch({ value: 'aaalogin', query: 'login', ...tiers });
const fuzzy = rank.scoreQueryMatch({ value: 'l-o-g-i-n', query: 'login', ...tiers });
ok(exact === 0, '分级：精确匹配 = 0');
ok(prefix === 13, '分级：前缀 = 10 + 长度惩罚 3');
ok(boundary === 32, '分级：词边界 = 20 + 位置 4×2 + 长度惩罚 4');
ok(includes === 39, '分级：包含 = 30 + 位置 3×2 + 长度惩罚 3');
ok(fuzzy === 80, '分级：模糊子序列 = 60 + 子序列分 20');
ok(exact < prefix && prefix < boundary && boundary < includes && includes < fuzzy, '分级顺序：精确 < 前缀 < 词边界 < 包含 < 模糊');
ok(rank.scoreQueryMatch({ value: 'nothing', query: 'zzz', exactBase: 0 }) === null, '无命中返回 null');

// ---- insertRankedSearchResult（二分插入 + 上限淘汰）----
const list = [];
rank.insertRankedSearchResult(list, { item: 'c', score: 30, tieBreaker: 'a' }, 3);
rank.insertRankedSearchResult(list, { item: 'a', score: 10, tieBreaker: 'a' }, 3);
rank.insertRankedSearchResult(list, { item: 'b', score: 20, tieBreaker: 'a' }, 3);
ok(list.map(x => x.item).join('') === 'abc', 'ranked：按分数升序插入');
rank.insertRankedSearchResult(list, { item: 'd', score: 25, tieBreaker: 'a' }, 3);
ok(list.map(x => x.item).join('') === 'abd', 'ranked：超出上限时淘汰最差项');
rank.insertRankedSearchResult(list, { item: 'z', score: 99, tieBreaker: 'a' }, 3);
ok(list.map(x => x.item).join('') === 'abd', 'ranked：比现有最差还差则丢弃');
const tieList = [];
rank.insertRankedSearchResult(tieList, { item: 'new', score: 5, tieBreaker: '0001' }, 2);
rank.insertRankedSearchResult(tieList, { item: 'old', score: 5, tieBreaker: '0002' }, 2);
ok(tieList.map(x => x.item).join(',') === 'new,old', 'ranked：同分按 tieBreaker 升序（倒序时间戳 → 新的在前）');
rank.insertRankedSearchResult(tieList, { item: 'skip', score: 5, tieBreaker: '0003' }, 0);
ok(tieList.length === 2, 'ranked：limit<=0 时不插入');

// ---- lib/../public/image-compression.js（移植自 t3code imageCompression.ts）----
const img = require('../public/image-compression');
ok(img.MAX_DIMENSION === 2048 && img.QUALITY_STEPS.join(',') === '0.92,0.85,0.78,0.68', '压缩：关键常量与原实现一致（2048 / 质量阶梯）');
ok(img.FALLBACK_SCALE_STEPS.join(',') === '0.75,0.55', '压缩：回退降分辨率阶梯一致');
ok(img.isHeicImageFile({ name: 'a.HEIC', type: '' }) === true, 'HEIC 识别：空 MIME + .HEIC 扩展名');
ok(img.isHeicImageFile({ name: 'a.jpg', type: 'application/octet-stream' }) === false, 'HEIC 识别：octet-stream 但扩展名不对 → 否');
ok(img.isHeicImageFile({ name: 'a.bin', type: 'image/heif' }) === true, 'HEIC 识别：MIME image/heif');
ok(img.isHeicImageFile({ name: 'a.png', type: 'image/png' }) === false, 'HEIC 识别：普通 PNG → 否');

ok(img.fileNameForMimeType('shot.png', 'image/webp') === 'shot.webp', '重编码改名：webp 扩展名');
ok(img.fileNameForMimeType('noext', 'image/jpeg') === 'noext.jpg', '重编码改名：无扩展名 → .jpg');
ok(img.dataUrlByteLength('data:image/png;base64,' + Buffer.from([1, 2, 3]).toString('base64')) === 3, 'dataUrl 字节数推算');
ok(img.bytesToBase64(new Uint8Array([1, 2, 3])) === Buffer.from([1, 2, 3]).toString('base64'), 'bytesToBase64 与 Buffer 一致');

// Node 22 有 Blob/File/atob/btoa：这类纯函数在测试环境同样可验证
(async () => {
  const blob = new Blob([Buffer.from('hello')], { type: 'text/plain' });
  const dataUrl = await img.blobToDataUrl(blob);
  ok(dataUrl.startsWith('data:text/plain;base64,') && dataUrl.endsWith(Buffer.from('hello').toString('base64')), 'blobToDataUrl 编码正确');
  const file = img.dataUrlToFile(dataUrl, 'x.txt', 'text/plain');
  ok(file.name === 'x.txt' && file.type === 'text/plain' && file.size === 5, 'dataUrlToFile 往返（名称/类型/大小）');

  const small = new File([Buffer.alloc(1024)], 'small.png', { type: 'image/png' });
  const pass = await img.compressImageToByteLimit(small, 4096);
  ok(pass.ok === true && pass.recompressed === false && pass.file === small, '限额内图片原样通过（不改字节）');
  const big = new File([Buffer.alloc(500 * 1024)], 'big.png', { type: 'image/png' });
  // 注意顺序与原实现一致：先看目标预算，再拒绝「源图超过 50MB」的大图
  const refused = await img.compressImageToByteLimit(big, 1024, { sourceSizeBytes: img.MAX_COMPRESSIBLE_SOURCE_BYTES + 1 });
  ok(refused.ok === false && refused.reason === 'too-large', '源图超过 50MB 且超预算 → 直接拒绝（不冒险解码）');
  const withinBudget = await img.compressImageToByteLimit(big, 1024 * 1024 * 1024, { sourceSizeBytes: img.MAX_COMPRESSIBLE_SOURCE_BYTES + 1 });
  ok(withinBudget.ok === true && withinBudget.recompressed === false, '预算足够时原样通过（源图上限只在需要重编码时生效）');
  const unreadable = await img.prepareImageForAttachment(new File([Buffer.from('not-a-heic')], 'x.heic', { type: 'image/heic' }), 4096);
  ok(unreadable.ok === false && unreadable.reason === 'unreadable', '伪造 HEIC → unreadable（元数据校验先拦下）');

  console.log(failed ? `ported-libs FAILED（${failed} 项）` : 'ported-libs passed');
  process.exit(failed ? 1 : 0);
})();
