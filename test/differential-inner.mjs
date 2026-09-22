// 差分测试（内核，需 --experimental-strip-types 运行）：
// 同一批输入分别喂给 上游 t3code 原版 TS 与 AgentHub 移植版，逐条比对输出。
// 说明：上游把若干辅助函数保持私有（未导出），这类改走**公开行为**比对
//（compressImageForStash 的原样通过路径内部会用到 base64/dataUrl 工具），
// 并用源码文本正则校验未导出的常量（MAX_DIMENSION / 质量阶梯）。
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..');
const UP = process.env.AGENTHUB_T3CODE_DIR || path.join(ROOT, '..', '_ref', 't3code');

const origRank = await import(pathToFileURL(path.join(UP, 'packages/shared/src/searchRanking.ts')).href);
const origImg = await import(pathToFileURL(path.join(UP, 'apps/web/src/lib/imageCompression.ts')).href);
const myRank = require(path.join(ROOT, 'lib/search-ranking.js'));
const myImg = require(path.join(ROOT, 'public/image-compression.js'));
const origImgSrc = fs.readFileSync(path.join(UP, 'apps/web/src/lib/imageCompression.ts'), 'utf8');

let failed = 0;
let checked = 0;
const bad = [];
const cmp = (label, a, b) => {
  checked++;
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) {
    failed++;
    if (bad.length < 10) bad.push(`${label}: 上游=${sa} 移植=${sb}`);
  }
};

// ---------------- 1) searchRanking：随机语料全量比对 ----------------
const alphabet = ['a', 'b', 'c', 'l', 'o', 'g', 'i', 'n', '-', '_', '/', ' ', 'x', 'Z'];
const rnd = (n) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
const queries = ['', 'a', 'ab', 'abc', 'login', 'LOGIN', 'l o g', 'x', 'zzz', '-', ' a'];
const values = [];
for (let i = 0; i < 400; i++) values.push(rnd(1 + Math.floor(Math.random() * 40)));
values.push('login', 'a-b-c', 'l-o-g-i-n', 'user-login-page', 'xloginx', 'a b c', 'A-B-C');

for (const v of values) {
  for (const q of queries) {
    cmp(`normalize(${JSON.stringify(v)})`, origRank.normalizeSearchQuery(v), myRank.normalizeSearchQuery(v));
    cmp(`normalize+trim(${JSON.stringify(v)})`, origRank.normalizeSearchQuery(v, { trimLeadingPattern: /^@/ }), myRank.normalizeSearchQuery(v, { trimLeadingPattern: /^@/ }));
    cmp(`subseq(${JSON.stringify(v)},${JSON.stringify(q)})`, origRank.scoreSubsequenceMatch(v, q), myRank.scoreSubsequenceMatch(v, q));
    const tiers = { exactBase: 0, prefixBase: 10, boundaryBase: 20, includesBase: 30, fuzzyBase: 60 };
    cmp(`match(${JSON.stringify(v)},${JSON.stringify(q)})`, origRank.scoreQueryMatch({ value: v, query: q, ...tiers }), myRank.scoreQueryMatch({ value: v, query: q, ...tiers }));
    const noFuzzy = { exactBase: 0, prefixBase: 5, boundaryBase: 15, includesBase: 25 };
    cmp(`match-noFuzzy(${JSON.stringify(v)},${JSON.stringify(q)})`, origRank.scoreQueryMatch({ value: v, query: q, ...noFuzzy }), myRank.scoreQueryMatch({ value: v, query: q, ...noFuzzy }));
    const markers = { exactBase: 0, boundaryBase: 7, boundaryMarkers: ['::', '.'] };
    cmp(`match-markers(${JSON.stringify(v)},${JSON.stringify(q)})`, origRank.scoreQueryMatch({ value: v, query: q, ...markers }), myRank.scoreQueryMatch({ value: v, query: q, ...markers }));
  }
}

for (let round = 0; round < 200; round++) {
  const limit = Math.floor(Math.random() * 5) + 1;
  const candidates = Array.from({ length: 8 }, (_, i) => ({
    item: 'i' + i,
    score: Math.floor(Math.random() * 6),
    tieBreaker: String(Math.floor(Math.random() * 4)),
  }));
  const a = [];
  const b = [];
  for (const c of candidates) {
    origRank.insertRankedSearchResult(a, { ...c }, limit);
    myRank.insertRankedSearchResult(b, { ...c }, limit);
  }
  cmp(`inserted(limit=${limit})`, a, b);
}

// ---------------- 2) imageCompression：导出的常量/函数 + 公开行为 ----------------
cmp('MAX_STASH_IMAGE_DATA_URL_CHARS', origImg.MAX_STASH_IMAGE_DATA_URL_CHARS, myImg.MAX_STASH_IMAGE_DATA_URL_CHARS);
cmp('MAX_COMPRESSIBLE_SOURCE_BYTES', origImg.MAX_COMPRESSIBLE_SOURCE_BYTES, myImg.MAX_COMPRESSIBLE_SOURCE_BYTES);

// 未导出的常量：与上游源文件中的字面量比对
const lit = (re, name) => {
  const m = re.exec(origImgSrc);
  checked++;
  if (!m) { failed++; bad.push(`源码里找不到 ${name}`); return null; }
  return m;
};
const md = lit(/const MAX_DIMENSION = (\d+);/, 'MAX_DIMENSION');
if (md) cmp('MAX_DIMENSION（源码字面量）', Number(md[1]), myImg.MAX_DIMENSION);
const qs = lit(/const QUALITY_STEPS = \[([^\]]+)\]/);
if (qs) cmp('QUALITY_STEPS（源码字面量）', qs[1].split(',').map(s => Number(s.trim())).filter(n => !Number.isNaN(n)), myImg.QUALITY_STEPS);
const fb = lit(/const FALLBACK_SCALE_STEPS = \[([^\]]+)\]/);
if (fb) cmp('FALLBACK_SCALE_STEPS（源码字面量）', fb[1].split(',').map(s => Number(s.trim())).filter(n => !Number.isNaN(n)), myImg.FALLBACK_SCALE_STEPS);

const fileShapes = [
  { name: 'a.HEIC', type: '' },
  { name: 'a.heif', type: 'application/octet-stream' },
  { name: 'a.HEIC', type: 'image/png' },
  { name: 'a.bin', type: 'image/heif' },
  { name: 'photo.jpg', type: 'image/jpeg' },
  { name: 'noext', type: '' },
];
for (const f of fileShapes) cmp(`isHeic(${JSON.stringify(f)})`, origImg.isHeicImageFile(f), myImg.isHeicImageFile(f));

// 公开行为 1：compressImageForStash 的原样通过路径（内部用 blobToDataUrl/长度估算）
for (let i = 0; i < 60; i++) {
  const len = Math.floor(Math.random() * 4096);
  const bytes = new Uint8Array(Array.from({ length: len }, () => Math.floor(Math.random() * 256)));
  const a = await origImg.compressImageForStash(new File([bytes], 'x.bin', { type: 'application/octet-stream' }), 1000000);
  const b = await myImg.compressImageForStash(new File([bytes], 'x.bin', { type: 'application/octet-stream' }), 1000000);
  cmp(`compressImageForStash(len=${len})`, a, b);
}

// 公开行为 2：compressImageToByteLimit 的原样通过 / 源图超限拒绝
for (let i = 0; i < 30; i++) {
  const len = Math.floor(Math.random() * 2048) + 1;
  const max = Math.random() < 0.5 ? len + 1000 : Math.max(1, len - 1);
  const bytes = new Uint8Array(len);
  const a = await origImg.compressImageToByteLimit(new File([bytes], 'x.bin'), max);
  const b = await myImg.compressImageToByteLimit(new File([bytes], 'x.bin'), max);
  cmp(`toByteLimit(len=${len},max=${max})`, { ok: a.ok, recompressed: a.recompressed, size: a.ok ? a.file.size : 0, reason: a.reason || '' }, { ok: b.ok, recompressed: b.recompressed, size: b.ok ? b.file.size : 0, reason: b.reason || '' });
}
const overA = await origImg.compressImageToByteLimit(new File([new Uint8Array(4096)], 'x.bin'), 1024, { sourceSizeBytes: 50 * 1024 * 1024 + 1 });
const overB = await myImg.compressImageToByteLimit(new File([new Uint8Array(4096)], 'x.bin'), 1024, { sourceSizeBytes: 50 * 1024 * 1024 + 1 });
cmp('toByteLimit(源图 >50MB 拒绝)', { ok: overA.ok, reason: overA.reason }, { ok: overB.ok, reason: overB.reason });

// 公开行为 3：prepareImageForAttachment 的分流（Node 无 canvas → 两边都拒绝；HEIC 元数据校验）
const plainA = await origImg.prepareImageForAttachment(new File([new Uint8Array(512)], 'p.png', { type: 'image/png' }), 4096);
const plainB = await myImg.prepareImageForAttachment(new File([new Uint8Array(512)], 'p.png', { type: 'image/png' }), 4096);
cmp('prepare(普通图超预算, 无 canvas)', { ok: plainA.ok, reason: plainA.reason }, { ok: plainB.ok, reason: plainB.reason });
const heicA = await origImg.prepareImageForAttachment(new File([new Uint8Array(64)], 'h.heic', { type: 'image/heic' }), 4096);
const heicB = await myImg.prepareImageForAttachment(new File([new Uint8Array(64)], 'h.heic', { type: 'image/heic' }), 4096);
cmp('prepare(伪造 HEIC)', { ok: heicA.ok, reason: heicA.reason }, { ok: heicB.ok, reason: heicB.reason });

// 移植版额外导出的私有函数（上游私有）：构造合成 ISOBMFF 做区间自检
function heicBuffer(width, height, { truncate = false } = {}) {
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
  const box = (type, payload) => Buffer.concat([u32(8 + payload.length), Buffer.from(type, 'latin1'), payload]);
  const ispe = box('ispe', Buffer.concat([Buffer.alloc(4), u32(width), u32(height)]));
  const buf = box('meta', Buffer.concat([Buffer.alloc(4), box('iprp', box('ipco', ispe))]));
  return truncate ? buf.subarray(0, Math.max(8, buf.length - 12)) : buf;
}
for (const [w, h, truncate] of [[100, 100, false], [20000, 20000, false], [1, 0, false], [50, 50, true]]) {
  const got = await myImg.validateHeicImageDimensions(new File([heicBuffer(w, h, { truncate })], 'x.heic', { type: 'image/heic' }));
  checked++;
  const expect = truncate ? ['unreadable'] : (w * h > 64000000 || h === 0 ? ['too-large', 'unreadable'] : [null]);
  if (!expect.includes(got)) { failed++; bad.push(`validateHeic(${w}x${h},truncate=${truncate}): 移植=${JSON.stringify(got)} 不在预期 ${JSON.stringify(expect)}`); }
}

console.log(`[differential] 与上游 t3code 原版比对 ${checked} 项，失败 ${failed} 项`);
if (bad.length) {
  console.error('[differential] 前若干差异：');
  for (const line of bad) console.error('  - ' + line);
}
process.exit(failed ? 1 : 0);
