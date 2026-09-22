// Office 预览解析：docx / xlsx / pptx 的压缩包 → HTML。
//
// 这一层的目标不是「把文字抠出来」，而是「看起来像原文」。旧实现只遍历
// w:t / a:t 取文本，于是带图报告的图片整段消失，居中、字号、颜色、表格
// 边框、幻灯片版式也全部丢掉——用户看到的是文件残影，不是预览。
//
// 安全前提：压缩包内容不可信。所有文本走全局 esc()；所有进 style 的取值
// 先经过数值收敛或 6 位十六进制白名单，绝不把文件里的字符串直接拼进 HTML。
// 依赖 app.js 的 esc()：本文件必须在 app.js 之后调用（defer 顺序见 index.html），
// 但不在顶层引用它，避免加载顺序变化时踩 TDZ。

const OFFICE_EMU_PER_PX = 9525;              // 914400 EMU = 1 英寸 = 96px
// 内联预算按「一次预览」算，不是按页算：每页重置预算会让 30 页各带满额图片，
// 拼出 65MB 的 HTML，面板直接卡死。
const OFFICE_MEDIA_MAX_BYTES = 6 * 1024 * 1024;      // 单张图片内联上限
const OFFICE_MEDIA_TOTAL_BYTES = 16 * 1024 * 1024;   // 单次预览内联总上限
// 渲染上限：超大文件只渲染前一部分并明确告知。宁可少显示，也不要把整页卡住。
const OFFICE_LIMITS = {
  docxBlocks: 12000,     // 段落 + 表格行；实测 7112 段的测试大纲要能整篇显示
  docxSliceBytes: 1024 * 1024,         // 每次交给 DOMParser 的正文上限（实测 1MB ≈ 0.35s 停顿）
  docxXmlHardBytes: 64 * 1024 * 1024,  // 解压后仍超过就拒绝：解压本身就会吃掉内存和主线程
  partXmlBytes: 24 * 1024 * 1024,      // xlsx 单张工作表 XML 的硬上限
  pptxSlides: 120,
  xlsxSheets: 20,
  xlsxRows: 200,
  xlsxCols: 30,
};
// 只内联浏览器能画的格式；emf/wmf/tiff 之类留给占位说明，避免一堆碎图。
const OFFICE_IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml',
};

function officeHex(value) {
  const s = String(value == null ? '' : value).trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(s) ? '#' + s.toLowerCase() : '';
}
// ARGB（xlsx 里常见 "FFRRGGBB"）与 6 位 hex 都收；其余返回空串。
function officeArgHex(value) {
  const s = String(value == null ? '' : value).trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{8}$/.test(s)) return officeHex(s.slice(2));
  return officeHex(s);
}
function officeClamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function officeEmuPx(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n / OFFICE_EMU_PER_PX : 0;
}
function officeTwipsPx(value) {                 // 20 twips = 1pt
  const n = Number(value);
  return Number.isFinite(n) ? n / 15 : 0;       // twips/20*96/72
}
function officeHalfPtPx(value) {                // docx w:sz 是半磅
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n / 2 * 96 / 72 : 0;
}
function officeStyle(pairs) {
  const out = [];
  for (const [key, value] of pairs) {
    if (value === '' || value == null) continue;
    // 这些值最终会拼进 style="..." 属性；值里出现双引号会提前闭合属性，
    // 后面所有声明一起失效。统一换成单引号（CSS 里等价），把隐患堵在出口。
    out.push(key + ':' + String(value).replace(/"/g, "'"));
  }
  return out.length ? out.join(';') : '';
}
// 让出主线程：JSZip 解压、DOMParser、innerHTML 都是同步的，一次做太多，
// 浏览器表现出来就是整页卡死。分片之间插一个宏观任务，页面才能重绘、进度才能刷新。
function officeYield() {
  return new Promise(resolve => setTimeout(resolve, 0));
}
function officeNote(text) {
  return text ? `<p class="dialog-note">${esc(text)}</p>` : '';
}
function officeBytesToBase64(bytes) {
  let out = '';
  // 分块避免 apply 参数爆栈；6MB 图片在这里也只是几十次拼接。
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}
function officeParseXml(text) {
  return new DOMParser().parseFromString(String(text || ''), 'text/xml');
}
// 压缩包里记录的「解压后大小」。用于在真正解压之前判断这个部件能不能碰——
// 几十 MB 的 document.xml 光是解压就要几百毫秒并占住主线程。
// JSZip 把这个值放在内部字段上；取不到就当未知（0），退回按内容判断。
function officeEntrySize(zip, name) {
  const entry = zip.file(name);
  const size = entry && entry._data && entry._data.uncompressedSize;
  return Number.isFinite(size) ? size : 0;
}
async function officeReadXml(zip, name) {
  const f = zip.file(name);
  return f ? officeParseXml(await f.async('string')) : null;
}
async function officeReadText(zip, name) {
  const f = zip.file(name);
  return f ? await f.async('string') : '';
}
// rels 里的 Target 相对部件所在目录；../media/x.png 要按目录栈收敛。
function officeJoinPath(partPath, target) {
  const parts = String(partPath || '').split('/').slice(0, -1);
  for (const seg of String(target || '').replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}
function officeRelsPath(partPath) {
  const cut = String(partPath).lastIndexOf('/');
  return (cut < 0 ? '' : partPath.slice(0, cut + 1)) + '_rels/' + partPath.slice(cut + 1) + '.rels';
}
// 返回 Map<rId, {target, external, type}>；target 已按部件目录归一化。
async function officeRels(zip, partPath) {
  const map = new Map();
  const doc = await officeReadXml(zip, officeRelsPath(partPath));
  if (!doc) return map;
  for (const rel of doc.getElementsByTagName('Relationship')) {
    const id = rel.getAttribute('Id');
    if (!id) continue;
    map.set(id, {
      target: officeJoinPath(partPath, rel.getAttribute('Target') || ''),
      external: /^external$/i.test(rel.getAttribute('TargetMode') || ''),
      type: rel.getAttribute('Type') || '',
    });
  }
  return map;
}
// 图片取值器。有两种形态：
//  - URL 模式（本机会话）：只回一个 /api/fs/office-media 地址，字节由浏览器按需拉取。
//    图片密集型文档（一份测试大纲 185 张截图）内联后是 70MB 的 HTML，页面会被这份
//    字符串拖死；URL 模式既不撑 DOM，也不需要在客户端解压任何媒体。
//  - 内联模式（远程 WSL/SSH）：压缩包已经在内存里，只能整块转 base64，
//    因此保留单张与总量预算，超预算的图退化成占位符并提示。
function officeMediaStore(zip, partUrl) {
  const cache = new Map();
  if (typeof partUrl === 'function') {
    return {
      // 仍然按扩展名筛一遍：emf/wmf/tiff 这类浏览器画不出来的格式要给占位符，
      // 不能因为「URL 模式下取值永远非空」就发一个必然 400 的 img 出来（裂图）。
      get: part => {
        const mime = OFFICE_IMAGE_MIME[(String(part).split('.').pop() || '').toLowerCase()];
        return mime ? (partUrl(part) || '') : '';
      },
      load: async () => '',
      skipped: () => 0,
      urlMode: true,
    };
  }
  let total = 0;
  let skipped = 0;
  const load = async path => {
    if (!path || cache.has(path)) return cache.get(path) || '';
    let url = '';
    const mime = OFFICE_IMAGE_MIME[(String(path).split('.').pop() || '').toLowerCase()];
    const f = mime ? zip.file(path) : null;
    if (f) {
      const bytes = await f.async('uint8array');
      if (bytes.length <= OFFICE_MEDIA_MAX_BYTES && total + bytes.length <= OFFICE_MEDIA_TOTAL_BYTES) {
        total += bytes.length;
        url = 'data:' + mime + ';base64,' + officeBytesToBase64(bytes);
      } else { skipped++; }
    }
    cache.set(path, url);
    return url;
  };
  return { load, get: path => cache.get(path) || '', skipped: () => skipped, urlMode: false };
}
// 解析出全部图片引用后再渲染，渲染阶段就能保持同步，递归好读也好测。
// 每张图之间让出一次主线程：几十张大图连着 base64 是最容易卡住页面的一段。
// URL 模式下没有需要预先解压的东西，直接返回。
async function officePreloadImages(zip, rels, store, progress) {
  if (store.urlMode) return;
  const targets = [];
  for (const rel of rels.values()) {
    if (rel.external) continue;
    if (OFFICE_IMAGE_MIME[(rel.target.split('.').pop() || '').toLowerCase()]) targets.push(rel.target);
  }
  for (const [index, target] of targets.entries()) {
    if (progress && targets.length > 4) progress(`正在处理图片 ${index + 1}/${targets.length}…`);
    await store.load(target);
    if (index % 4 === 3) await officeYield();
  }
}

// ---------------------------------------------------------------- DOCX ----

// 字体名要能安全进 style：只留常规字符，引号 / 分号 / 反斜杠一律剔掉。
// "+mn-lt" 这类主题字体占位也丢掉，交给 CSS 兜底。
function docxFontFace(face) {
  const safe = String(face || '').replace(/[^\w \u4e00-\u9fa5\u3040-\u30ff-]/g, '').slice(0, 40).trim();
  return safe && !safe.startsWith('+') ? safe : '';
}
// 字体栈：每个字面单独加引号，末尾接应用字体，避免文档字体缺失时出现默认衬线。
// 必须用单引号：这段字符串最终落在 style="..." 属性里，双引号会提前闭合属性，
// 整条声明被浏览器当作无效值丢掉，字体静默失效。
function officeFontStack(fonts) {
  const list = (Array.isArray(fonts) ? fonts : String(fonts || '').split(','));
  const faces = list.map(f => docxFontFace(f)).filter(Boolean);
  return faces.length ? faces.map(f => `'${f}'`).join(',') + ',var(--font-main)' : '';
}
// w:rPr → 运行属性。w:b/w:i 这类开关的 val="0" 是「显式关闭」，
// 不能只看元素在不在，否则继承来的样式会被反转。
function docxOnOff(el) {
  if (!el) return null;
  const v = (el.getAttribute('w:val') || '').toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}
function docxRunProps(rPr) {
  const out = {};
  if (!rPr) return out;
  const first = tag => rPr.getElementsByTagName(tag)[0];
  const set = (key, value) => { if (value !== undefined && value !== null) out[key] = value; };
  set('b', docxOnOff(first('w:b')));
  set('i', docxOnOff(first('w:i')));
  set('strike', docxOnOff(first('w:strike')) ?? docxOnOff(first('w:dstrike')));
  const u = first('w:u');
  if (u) set('u', (u.getAttribute('w:val') || 'single').toLowerCase() !== 'none');
  const color = first('w:color');
  if (color) {
    const hex = officeHex(color.getAttribute('w:val'));
    if (hex) set('color', hex);
    else if (/^auto$/i.test(color.getAttribute('w:val') || '')) set('color', '');
  }
  const sz = first('w:sz');
  if (sz) { const px = officeHalfPtPx(sz.getAttribute('w:val')); if (px) set('size', px); }
  const hl = first('w:highlight');
  if (hl) { const hex = officeHex(hl.getAttribute('w:val')); if (hex) set('highlight', hex); else set('highlight', 'highlight'); }
  const shd = first('w:shd');
  if (shd) { const hex = officeHex(shd.getAttribute('w:fill')); if (hex) set('shade', hex); }
  const va = first('w:vertAlign');
  if (va) set('vertAlign', (va.getAttribute('w:val') || '').toLowerCase());
  const fonts = first('w:rFonts');
  if (fonts) {
    // 中西文常是两个不同字面（公文正文典型是 Times New Roman + 仿宋），
    // 只取一个会让另一种文字落到兜底字体上。这里拼成字体栈交给浏览器按字符选。
    const faces = [];
    for (const attr of ['w:ascii', 'w:eastAsia', 'w:cs']) {
      const face = docxFontFace(fonts.getAttribute(attr));
      if (face && !faces.includes(face)) faces.push(face);
    }
    if (faces.length) set('font', faces.join(','));
  }
  const caps = first('w:caps');
  if (caps && docxOnOff(caps)) set('caps', true);
  return out;
}
// w:pPr → 段落属性
function docxParaProps(pPr) {
  const out = {};
  if (!pPr) return out;
  const first = tag => pPr.getElementsByTagName(tag)[0];
  const jc = first('w:jc');
  if (jc) {
    const v = (jc.getAttribute('w:val') || '').toLowerCase();
    if (['left', 'start'].includes(v)) out.align = 'left';
    else if (['center', 'centre'].includes(v)) out.align = 'center';
    else if (['right', 'end'].includes(v)) out.align = 'right';
    else if (['both', 'justify', 'distribute'].includes(v)) out.align = 'justify';
  }
  const ind = first('w:ind');
  if (ind) {
    const left = officeTwipsPx(ind.getAttribute('w:left') ?? ind.getAttribute('w:start'));
    const right = officeTwipsPx(ind.getAttribute('w:right') ?? ind.getAttribute('w:end'));
    const hanging = officeTwipsPx(ind.getAttribute('w:hanging'));
    const firstLine = officeTwipsPx(ind.getAttribute('w:firstLine'));
    if (left) out.left = left;
    if (right) out.right = right;
    if (hanging) out.hanging = hanging;
    else if (firstLine) out.firstLine = firstLine;
    // 中文文档的缩进常按「字符」写（firstLineChars="200" 即首行缩进两字）。
    // 只认 twips 会让整篇正文丢掉首行缩进，看起来就是「和 Word 不一样」。
    // 单位是 1/100 字符，渲染时按该段字号折算成 px（见 docxParagraph）。
    const charVal = key => {
      const n = Number(ind.getAttribute(key));
      return Number.isFinite(n) && n !== 0 ? n / 100 : 0;
    };
    const leftChars = charVal('w:leftChars') || charVal('w:startChars');
    const firstLineChars = charVal('w:firstLineChars');
    const hangingChars = charVal('w:hangingChars');
    if (leftChars) out.leftChars = leftChars;
    if (firstLineChars) out.firstLineChars = firstLineChars;
    if (hangingChars) out.hangingChars = hangingChars;
  }
  // 制表位：目录里的「标题……页码」就是右对齐制表位加点前导符。
  const tabsEl = first('w:tabs');
  if (tabsEl) {
    out.tabs = [...tabsEl.getElementsByTagName('w:tab')].map(t => ({
      val: (t.getAttribute('w:val') || 'left').toLowerCase(),
      pos: officeTwipsPx(t.getAttribute('w:pos')),
      leader: (t.getAttribute('w:leader') || 'none').toLowerCase(),
    })).filter(t => t.pos > 1);
  }
  const spacing = first('w:spacing');
  if (spacing) {
    const before = officeTwipsPx(spacing.getAttribute('w:before'));
    const after = officeTwipsPx(spacing.getAttribute('w:after'));
    const line = Number(spacing.getAttribute('w:line'));
    const rule = (spacing.getAttribute('w:lineRule') || 'auto').toLowerCase();
    if (before) out.before = before;
    if (after) out.after = after;
    if (Number.isFinite(line) && line > 0) out.line = rule === 'auto' ? line / 240 : officeTwipsPx(line);
    if (out.line) out.lineRule = rule;
  }
  const shd = first('w:shd');
  if (shd) { const hex = officeHex(shd.getAttribute('w:fill')); if (hex) out.shade = hex; }
  const style = first('w:pStyle');
  if (style) out.styleId = style.getAttribute('w:val') || '';
  const numPr = first('w:numPr');
  if (numPr) {
    const numId = numPr.getElementsByTagName('w:numId')[0];
    const ilvl = numPr.getElementsByTagName('w:ilvl')[0];
    // numId=0 表示「取消编号」，不是「编号 0」。
    const id = numId ? numId.getAttribute('w:val') : null;
    if (id && id !== '0') {
      out.numId = id;
      out.ilvl = officeClamp(ilvl ? ilvl.getAttribute('w:val') : 0, 0, 8, 0);
    }
  }
  const outline = first('w:outlineLvl');
  if (outline) out.outlineLvl = officeClamp(outline.getAttribute('w:val'), 0, 8, 0);
  const rPr = pPr.getElementsByTagName('w:rPr')[0];
  if (rPr) out.run = docxRunProps(rPr);
  return out;
}
// 标题判定：styleId / 样式名 / outlineLvl 三条路都认，兼容 Word 新旧文件
// （"Heading1"、"Heading 1"、"heading 1" 与中文模板的"标题 1"）。
function docxHeadingLevel(props, style) {
  const candidates = [style && style.name, props.styleId].filter(Boolean);
  for (const raw of candidates) {
    const text = String(raw).trim();
    // "heading 1" / "Heading1" / "标题 1" 就是一级标题 → h1。这里不再往上挪一级：
    // 上一版把 Heading N 映射成 h(N+1)，字号比 Word 小一档，整篇层级观感都偏小。
    const m = /^heading\s*([1-9])$/i.exec(text) || /^标题\s*([1-9])$/.exec(text) || /^(?:heading|标题)([1-9])$/i.exec(text);
    if (m) return Math.min(4, +m[1]);
    if (/^title$/i.test(text)) return 1;
    if (/^subtitle$/i.test(text)) return 2;
  }
  // 大纲级别 0-5 就是标题（0 = 一级）；9 是 Word 给正文的「大纲级别 9」，不能当标题。
  if (typeof props.outlineLvl === 'number' && props.outlineLvl <= 5) return Math.min(4, props.outlineLvl + 1);
  return 0;
}
// styles.xml：段落样式表 + 文档默认运行属性，用于标题层级和默认字号/字体。
function docxStyles(doc) {
  const styles = new Map();
  let defaults = {};
  if (!doc) return { styles, defaults };
  const dd = doc.getElementsByTagName('w:docDefaults')[0];
  if (dd) {
    const rPr = dd.getElementsByTagName('w:rPr')[0];
    if (rPr) defaults = docxRunProps(rPr);
  }
  for (const st of doc.getElementsByTagName('w:style')) {
    if ((st.getAttribute('w:type') || '') !== 'paragraph') continue;
    const id = st.getAttribute('w:styleId') || '';
    if (!id) continue;
    const nameEl = st.getElementsByTagName('w:name')[0];
    const pPr = st.getElementsByTagName('w:pPr')[0];
    const rPr = st.getElementsByTagName('w:rPr')[0];
    const para = docxParaProps(pPr);
    const name = nameEl ? (nameEl.getAttribute('w:val') || '') : '';
    styles.set(id, {
      name, basedOn: (st.getElementsByTagName('w:basedOn')[0] || { getAttribute: () => '' }).getAttribute('w:val') || '',
      run: rPr ? docxRunProps(rPr) : {}, para,
      isHeading: /^(heading|标题)/i.test(name) || /^(heading|标题)/i.test(id),
    });
  }
  return { styles, defaults };
}
function docxResolveStyle(id, table, seen) {
  if (!id || seen.has(id)) return { run: {}, para: {} };
  const style = table.styles.get(id);
  if (!style) return { run: {}, para: {} };
  seen.add(id);
  const parent = docxResolveStyle(style.basedOn, table, seen);
  return {
    style,
    run: { ...parent.run, ...style.run },
    para: { ...parent.para, ...style.para },
  };
}
// 编号定义：numId → ilvl → {bullet, none, fmt, text, start}，以及 numId 上的起始值覆盖
function docxNumbering(doc) {
  const abstractById = new Map();
  const numToAbstract = new Map();
  const numOverrides = new Map();
  if (!doc) return { numToAbstract, abstractById, numOverrides };
  for (const an of doc.getElementsByTagName('w:abstractNum')) {
    const id = an.getAttribute('w:abstractNumId');
    if (!id) continue;
    const levels = new Map();
    for (const lvl of an.getElementsByTagName('w:lvl')) {
      const ilvl = officeClamp(lvl.getAttribute('w:ilvl'), 0, 8, 0);
      const fmt = (lvl.getElementsByTagName('w:numFmt')[0] || { getAttribute: () => '' }).getAttribute('w:val') || '';
      const text = (lvl.getElementsByTagName('w:lvlText')[0] || { getAttribute: () => '' }).getAttribute('w:val') || '';
      const start = Number((lvl.getElementsByTagName('w:start')[0] || { getAttribute: () => '' }).getAttribute('w:val'));
      levels.set(ilvl, {
        bullet: /^bullet$/i.test(fmt), none: /^none$/i.test(fmt), fmt, text,
        start: Number.isFinite(start) && start > 0 ? start : 1,
      });
    }
    abstractById.set(id, levels);
  }
  for (const num of doc.getElementsByTagName('w:num')) {
    const id = num.getAttribute('w:numId');
    const ref = num.getElementsByTagName('w:abstractNumId')[0];
    if (!id || !ref) continue;
    numToAbstract.set(id, ref.getAttribute('w:val') || '');
    const overrides = new Map();
    for (const ov of num.getElementsByTagName('w:lvlOverride')) {
      const ilvl = officeClamp(ov.getAttribute('w:ilvl'), 0, 8, 0);
      const startOv = ov.getElementsByTagName('w:startOverride')[0];
      if (startOv) overrides.set(ilvl, { start: Number(startOv.getAttribute('w:val')) || 1 });
    }
    if (overrides.size) numOverrides.set(id, overrides);
  }
  return { numToAbstract, abstractById, numOverrides };
}
// Word 的编号是按 numId + 级别累计的计数器：同级递增，出现更浅的级别就把更深的清零。
// lvlText 里的 %1..%9 取各级当前值——"%1.%2" 在一级=5、二级=3 时渲染成 "5.3"，
// 这正是「一级标题 5 / 二级条标题 5.3」的来源，缺了它就只剩光秃秃的标题文字。
function docxNumberMarker(para, ctx) {
  const numId = para.numId;
  if (!numId) return null;
  const abstractId = ctx.numbering.numToAbstract.get(String(numId));
  const levels = abstractId != null ? ctx.numbering.abstractById.get(abstractId) : null;
  if (!levels) return null;
  const ilvl = officeClamp(para.ilvl, 0, 8, 0);
  const level = levels.get(ilvl);
  if (level && level.none) return null;
  const overrides = ctx.numbering.numOverrides.get(String(numId));
  const startOf = lv => {
    const ov = overrides && overrides.get(lv);
    if (ov) return ov.start;
    const def = levels.get(lv);
    return def && def.start ? def.start : 1;
  };
  const key = lv => numId + ':' + lv;
  const current = ctx.counters.get(key(ilvl));
  const value = (current != null ? current : startOf(ilvl) - 1) + 1;
  ctx.counters.set(key(ilvl), value);
  for (const k of [...ctx.counters.keys()]) {
    const cut = k.lastIndexOf(':');
    if (k.slice(0, cut) === String(numId) && Number(k.slice(cut + 1)) > ilvl) ctx.counters.delete(k);
  }
  if (level && level.bullet) return { bullet: true, text: level.text || '•' };
  const text = String((level && level.text) || '%1.').replace(/%([1-9])/g, (_, digit) => {
    const lv = Number(digit) - 1;
    if (lv === ilvl) return String(value);
    const parent = ctx.counters.get(key(lv));
    return String(parent != null ? parent : startOf(lv));
  });
  return { bullet: false, text };
}
// 运行级 HTML：图片走 <img>，其余按样式包标签。
function docxRunsHtml(parent, ctx) {
  const parts = [];
  for (const node of parent.childNodes) {
    const tag = node.tagName;
    if (tag === 'w:r') parts.push(docxRunHtml(node, ctx));
    else if (tag === 'w:hyperlink') {
      const rel = ctx.rels.get(node.getAttribute('r:id') || '');
      const inner = docxRunsHtml(node, ctx);
      if (!inner) continue;
      if (rel && rel.external && /^https?:/i.test(rel.target)) {
        parts.push(`<a href="${esc(rel.target)}" target="_blank" rel="noopener noreferrer">${inner}</a>`);
      } else parts.push(inner);
    } else if (tag === 'w:smartTag' || tag === 'w:sdt' || tag === 'w:sdtContent' || tag === 'w:ins' || tag === 'w:bdo' || tag === 'w:dir') {
      parts.push(docxRunsHtml(node, ctx));
    }
  }
  return parts.join('');
}
function docxRunHtml(r, ctx) {
  const props = { ...(ctx.styleRun || {}), ...docxRunProps(r.getElementsByTagName('w:rPr')[0]) };
  const inner = [];
  for (const node of r.childNodes) {
    const tag = node.tagName;
    if (tag === 'w:t') inner.push(esc(node.textContent));
    else if (tag === 'w:br') {
      // 显式分页符：Word 在这里换页，预览也必须断开，否则整篇连成一片。
      if ((node.getAttribute('w:type') || '').toLowerCase() === 'page') inner.push(DOCX_PAGE_BREAK);
      else inner.push('<br>');
    }
    else if (tag === 'w:cr') inner.push('<br>');
    else if (tag === 'w:tab') inner.push(ctx.leaderTab ? '<span class="docx-tab-fill"></span>' : '<span class="docx-tab"></span>');
    else if (tag === 'w:noBreakHyphen') inner.push('-');
    else if (tag === 'w:sym') inner.push(esc(node.getAttribute('w:char') || ''));
    else if (tag === 'w:drawing') inner.push(docxDrawingHtml(node, ctx));
    else if (tag === 'w:pict' || tag === 'w:object') inner.push(docxVmlHtml(node, ctx));
    else if (tag === 'w:txbxContent') inner.push(docxRunsHtml(node, ctx));
  }
  const body = inner.join('');
  if (!body) return '';
  const css = officeStyle([
    ['font-weight', props.b ? '700' : ''],
    ['font-style', props.i ? 'italic' : ''],
    ['text-decoration', [props.u ? 'underline' : '', props.strike ? 'line-through' : ''].filter(Boolean).join(' ')],
    ['color', props.color || ''],
    ['background-color', props.highlight === 'highlight' ? 'rgba(255,214,0,.42)' : (props.highlight || props.shade || '')],
    ['font-size', props.size ? props.size.toFixed(1) + 'px' : ''],
    ['font-family', officeFontStack(props.font)],
    ['vertical-align', props.vertAlign === 'superscript' ? 'super' : (props.vertAlign === 'subscript' ? 'sub' : '')],
    ['text-transform', props.caps ? 'uppercase' : ''],
  ]);
  if (!css) return body;
  const cls = props.vertAlign === 'superscript' || props.vertAlign === 'subscript' ? ' class="docx-vr"' : '';
  return `<span${cls} style="${css}">${body}</span>`;
}
// 图片：wp:extent 给显示尺寸（EMU），a:blip@r:embed 经 rels 找到 media 文件。
function docxPictureHtml(pic, ctx, extent) {
  const blip = pic.getElementsByTagName('a:blip')[0];
  const embed = blip ? (blip.getAttribute('r:embed') || blip.getAttribute('r:link')) : '';
  const rel = embed ? ctx.rels.get(embed) : null;
  const url = rel && !rel.external ? ctx.media.get(rel.target) : '';
  const docPr = pic.getElementsByTagName('wp:docPr')[0] || pic.getElementsByTagName('pic:cNvPr')[0];
  const alt = docPr ? (docPr.getAttribute('descr') || docPr.getAttribute('name') || '') : '';
  let w = extent ? officeEmuPx(extent.getAttribute('cx')) : 0;
  let h = extent ? officeEmuPx(extent.getAttribute('cy')) : 0;
  if (!w || !h) {
    const ext = pic.getElementsByTagName('a:ext')[0];
    if (ext) { w = w || officeEmuPx(ext.getAttribute('cx')); h = h || officeEmuPx(ext.getAttribute('cy')); }
  }
  const size = officeStyle([
    ['width', w > 1 ? Math.min(w, 4000).toFixed(0) + 'px' : ''],
    ['height', h > 1 ? Math.min(h, 4000).toFixed(0) + 'px' : ''],
  ]);
  if (!url) {
    return `<span class="docx-image-missing" title="${esc(alt || '图片')}">[图片无法预览]</span>`;
  }
  // 懒加载 + 异步解码是这份文档能不能滚动的关键：180 张截图解码后合计约 600MB
  // （最大单张 3796×1923 = 28MB），一开预览就全部解码会直接把内存和 GPU 打满，
  // 滚动时还要反复重采样这些巨型位图。懒加载只解码视野附近的几张。
  return `<img class="docx-img" src="${esc(url)}" alt="${esc(alt)}" loading="lazy" decoding="async"${size ? ` style="${size}"` : ''}>`;
}
function docxDrawingHtml(drawing, ctx) {
  const out = [];
  for (const pic of drawing.getElementsByTagName('pic:pic')) {
    out.push(docxPictureHtml(pic, ctx, docxExtentFor(pic, drawing)));
  }
  // 图表 / SmartArt / 形状：没有可画的图片，至少留下说明而不是静默丢内容。
  if (!out.length) {
    const frame = drawing.getElementsByTagName('wps:wsp').length || drawing.getElementsByTagName('wpg:wgp').length;
    const chart = drawing.getElementsByTagName('c:chart').length;
    if (chart) out.push('<span class="docx-placeholder">[图表]</span>');
    else if (frame) out.push('<span class="docx-placeholder">[图形]</span>');
  }
  return out.join('');
}
// inline 图尺寸在 wp:inline/wp:anchor 上，不在 pic 里；就近往上找。
function docxExtentFor(pic, fallbackRoot) {
  let node = pic.parentNode;
  while (node && node.getElementsByTagName) {
    if (node.tagName === 'wp:inline' || node.tagName === 'wp:anchor') {
      const ext = node.getElementsByTagName('wp:extent')[0];
      if (ext) return ext;
    }
    if (node === fallbackRoot || node === node.ownerDocument) break;
    node = node.parentNode;
  }
  return fallbackRoot ? fallbackRoot.getElementsByTagName('wp:extent')[0] || null : null;
}
// VML 图片（老 Word / 部分导出工具用 w:pict + v:imagedata）
function docxVmlHtml(pict, ctx) {
  const out = [];
  for (const data of pict.getElementsByTagName('v:imagedata')) {
    const rel = ctx.rels.get(data.getAttribute('r:id') || '');
    const url = rel && !rel.external ? ctx.media.get(rel.target) : '';
    const alt = data.getAttribute('o:title') || '';
    out.push(url
      ? `<img class="docx-img" src="${esc(url)}" alt="${esc(alt)}" loading="lazy" decoding="async">`
      : '<span class="docx-image-missing">[图片无法预览]</span>');
  }
  for (const box of pict.getElementsByTagName('w:txbxContent')) out.push(docxRunsHtml(box, ctx));
  return out.join('');
}
// 段落 → HTML 片段 + 类型，供块级遍历决定要不要包 <p>/<h*>。
function docxParagraph(p, ctx) {
  const props = docxParaProps(p.getElementsByTagName('w:pPr')[0]);
  const resolved = docxResolveStyle(props.styleId, ctx.table, new Set());
  const para = { ...resolved.para, ...props };
  const run = { ...(ctx.defaults || {}), ...resolved.run, ...(para.run || {}) };
  // 字符单位的缩进按本段字号折算：1 字符 = 1em（中西文都是这个规则）。
  // 段落本身常常不写 w:sz（字号在 run 上），此时取首个 run 的字号，避免
  // 用兜底值算出偏小的缩进。
  let fontPx = run.size || ctx.defaults.size || 0;
  if (!fontPx) {
    const firstRun = p.getElementsByTagName('w:r')[0];
    const runProps = firstRun ? docxRunProps(firstRun.getElementsByTagName('w:rPr')[0]) : null;
    fontPx = (runProps && runProps.size) || 14;
  }
  const indentLeft = para.leftChars ? para.leftChars * fontPx : para.left;
  const indentRight = para.rightChars ? para.rightChars * fontPx : para.right;
  const indentHanging = para.hangingChars ? para.hangingChars * fontPx : para.hanging;
  const indentFirst = para.firstLineChars ? para.firstLineChars * fontPx : para.firstLine;
  // 带前导符的制表位（目录那种「标题……页码」）改用 flex 布局，tab 变成填充块。
  const leaderTab = (para.tabs || []).some(t => t.leader && t.leader !== 'none');
  const html = docxRunsHtml(p, { ...ctx, styleRun: run, leaderTab });
  if (!html.trim()) return null;
  const marker = docxNumberMarker(para, ctx);
  const heading = docxHeadingLevel(para, resolved.style);
  // 带编号的标题要按标题渲染（编号当前缀），否则会退化成一堆平级列表项；
  // 只有非标题的编号段落才走列表。
  const list = (!heading && marker)
    ? { ordered: !marker.bullet, level: para.ilvl || 0, marker: marker.bullet ? '' : marker.text, bullet: marker.bullet ? marker.text : '' }
    : null;
  // w:spacing@w:line 的语义随 lineRule 变：auto 是 240 分之一的行距倍数，
  // atLeast/exact 才是绝对值（twips）。混着算会让行距忽大忽小。
  let lineHeight = '';
  if (para.line) lineHeight = para.lineRule === 'auto' ? String(para.line) : para.line.toFixed(0) + 'px';
  // 悬挂缩进由 padding-left + 负 text-indent 实现，标记才会挂在正文左侧。
  const padLeft = list && indentLeft ? Math.max(0, indentLeft - (indentHanging || 0)) : indentLeft;
  const css = officeStyle([
    ['text-align', para.align || ''],
    ['margin-left', padLeft ? padLeft.toFixed(0) + 'px' : ''],
    ['margin-right', indentRight ? indentRight.toFixed(0) + 'px' : ''],
    ['padding-left', list && indentLeft ? Math.max(0, indentLeft - (indentHanging || 0)).toFixed(0) + 'px' : ''],
    ['text-indent', list && indentHanging ? (-indentHanging).toFixed(0) + 'px'
      : (indentHanging && !list ? (-indentHanging).toFixed(0) + 'px'
        : (indentFirst ? indentFirst.toFixed(0) + 'px' : ''))],
    ['margin-top', para.before ? para.before.toFixed(0) + 'px' : ''],
    ['margin-bottom', para.after ? para.after.toFixed(0) + 'px' : ''],
    ['line-height', lineHeight],
    ['background-color', para.shade || ''],
  ]);
  return { html, css, list, heading, level: para.outlineLvl, marker, leaderTab };
}
function docxCellContentHtml(nodes, ctx) {
  // 单元格里连续的普通段落拍平成行内内容（用 <br> 分隔），避免每个单元格
  // 都套一层带外边距的 <p>；只有带对齐/底纹/缩进的段落才保留块级样式。
  const out = [];
  let inlineBuffered = [];
  const flush = () => {
    if (inlineBuffered.length) { out.push(`<div class="docx-cell-line">${inlineBuffered.join('<br>')}</div>`); inlineBuffered = []; }
  };
  for (const el of nodes) {
    if (el.tagName === 'w:p') {
      const para = docxParagraph(el, ctx);
      if (!para) continue;
      if (!para.css && !para.list && !para.heading) inlineBuffered.push(para.html);
      else {
        flush();
        if (para.list) out.push(docxListHtml([para], ctx));
        else out.push(`<p class="docx-p"${para.css ? ` style="${para.css}"` : ''}>${para.html}</p>`);
      }
    } else if (el.tagName === 'w:tbl') {
      flush();
      out.push(docxTableHtml(el, ctx));
    } else if (el.tagName === 'w:sdt') {
      flush();
      out.push(docxCellContentHtml([...(el.getElementsByTagName('w:sdtContent')[0] || el).children], ctx));
    }
  }
  flush();
  return out.join('');
}
function docxListHtml(items, ctx) {
  const tag = items[0].list.ordered ? 'ol' : 'ul';
  // 有序列表直接用 Word 的编号文本（"（1）"、"1.1" 之类），
  // 交给浏览器自动编号会换成另一套数字，和原文对不上。
  const out = [`<${tag} class="docx-list${items[0].list.ordered ? ' docx-list-plain' : ''}">`];
  let depth = 0;
  for (const item of items) {
    const level = Math.min(item.list.level, 3);
    while (depth < level) { out.push(`<${tag}>`); depth++; }
    while (depth > level) { out.push(`</${tag}>`); depth--; }
    const marker = item.list.marker ? `<span class="docx-num">${esc(item.list.marker)}</span>` : '';
    out.push(`<li>${marker}${item.html}</li>`);
  }
  while (depth > 0) { out.push(`</${tag}>`); depth--; }
  out.push(`</${tag}>`);
  return out.join('');
}
// 表格边框：docx 默认不画边框（除非样式里给了），有 tblBorders 才画。
function docxTableBorders(tblPr) {
  if (!tblPr) return null;
  const borders = tblPr.getElementsByTagName('w:tblBorders')[0];
  if (!borders) return null;
  const read = tag => {
    const el = borders.getElementsByTagName('w:' + tag)[0];
    if (!el) return null;
    const val = (el.getAttribute('w:val') || '').toLowerCase();
    if (!val || val === 'none' || val === 'nil') return null;
    return {
      color: officeHex(el.getAttribute('w:color')) || 'currentColor',
      width: Math.max(1, Math.round((Number(el.getAttribute('w:sz')) || 4) / 8 * 96 / 72)),
    };
  };
  const inside = read('insideH') || read('insideV');
  const edge = read('top') || read('left') || read('bottom') || read('right');
  if (!inside && !edge) return null;
  return { edge: edge || inside, inside: inside || edge };
}
// 表格几何：Word 的列宽来自 tblGrid（每列一个 gridCol），表宽来自 tblW。
// 不还原这个就只能让浏览器按内容自动分配列宽，表格比例和原文差很多——
// 而这类文档恰恰以表格为主。tblW 的 pct 单位是「五十分之一百分点」。
function docxTableGeometry(tbl, tblPr, contentWidthPx) {
  const grid = [...tbl.getElementsByTagName('w:gridCol')].map(c => officeTwipsPx(c.getAttribute('w:w')));
  const gridTotal = grid.reduce((a, b) => a + b, 0);
  const tblW = tblPr ? tblPr.getElementsByTagName('w:tblW')[0] : null;
  const type = tblW ? (tblW.getAttribute('w:type') || 'auto').toLowerCase() : 'auto';
  const raw = tblW ? Number(tblW.getAttribute('w:w')) : 0;
  let widthPx = 0;
  if (type === 'pct' && Number.isFinite(raw) && raw > 0) widthPx = contentWidthPx * raw / 5000;
  else if (type === 'dxa' && Number.isFinite(raw) && raw > 0) widthPx = officeTwipsPx(raw);
  if (!widthPx && gridTotal) widthPx = gridTotal;
  // 有网格就用固定布局 + 百分比列宽，列宽比例才和 Word 一致；
  // 没有网格（少数生成器不写）时退回原来的自动布局。
  const cols = gridTotal > 0 && grid.length ? grid.map(w => (w / gridTotal * 100).toFixed(3) + '%') : null;
  return { widthPx: Math.min(widthPx || contentWidthPx, contentWidthPx * 1.6), cols };
}
function docxTableHtml(tbl, ctx) {
  const tblPr = tbl.getElementsByTagName('w:tblPr')[0];
  const borders = docxTableBorders(tblPr);
  const geo = docxTableGeometry(tbl, tblPr, ctx.contentWidth || 640);
  const rows = [];
  const spans = [];                     // 每行的单元格对象，稍后回填 rowspan
  const pending = new Map();            // 网格列 → 需要被 vMerge 继续的单元格
  for (const tr of tbl.children) {
    if (tr.tagName !== 'w:tr') continue;
    const isHeader = !!tr.getElementsByTagName('w:tblHeader').length;
    const cells = [];
    let col = 0;
    for (const tc of tr.children) {
      if (tc.tagName !== 'w:tc') continue;
      const tcPr = tc.getElementsByTagName('w:tcPr')[0];
      const span = tcPr ? tc.getElementsByTagName('w:gridSpan')[0] : null;
      const colspan = Math.max(1, officeClamp(span ? span.getAttribute('w:val') : 1, 1, 64, 1));
      const vMergeEl = tcPr ? tcPr.getElementsByTagName('w:vMerge')[0] : null;
      const vMerge = vMergeEl ? ((vMergeEl.getAttribute('w:val') || 'continue').toLowerCase()) : '';
      const home = pending.get(col);
      if (vMerge === 'continue' && home && home.colspan === colspan) {
        home.cell.rowspan = (home.cell.rowspan || 1) + 1;
        col += colspan;
        continue;
      }
      const cell = { colspan, rowspan: 1, html: docxCellContentHtml([...tc.children], ctx) };
      const shd = tcPr ? tcPr.getElementsByTagName('w:shd')[0] : null;
      const fill = shd ? officeHex(shd.getAttribute('w:fill')) : '';
      if (fill) cell.fill = fill;
      const vAlign = tcPr ? tcPr.getElementsByTagName('w:vAlign')[0] : null;
      if (vAlign) cell.vAlign = (vAlign.getAttribute('w:val') || '').toLowerCase();
      const widthEl = tcPr ? tcPr.getElementsByTagName('w:tcW')[0] : null;
      if (widthEl && (widthEl.getAttribute('w:type') || 'dxa') === 'dxa') {
        const w = officeTwipsPx(widthEl.getAttribute('w:w'));
        if (w > 4) cell.width = w;
      }
      // vMerge=restart 开启纵向合并；同一列出现新的独立单元格就结束上一次合并。
      if (vMerge === 'restart') pending.set(col, { cell, colspan });
      else pending.delete(col);
      cells.push(cell);
      col += colspan;
    }
    if (cells.length) { spans.push(cells); rows.push({ isHeader, count: cells.length }); }
  }
  if (!spans.length) return '';
  const headRows = rows.length && rows[0].isHeader ? 1 : 0;
  const cellHtml = (cell, tag) => {
    const css = officeStyle([
      ['background-color', cell.fill || ''],
      ['text-align', tag === 'th' ? 'start' : ''],
      ['vertical-align', cell.vAlign === 'center' ? 'middle' : (cell.vAlign === 'bottom' ? 'bottom' : '')],
      ['width', cell.width ? cell.width.toFixed(0) + 'px' : ''],
      ['border', borders && tag === 'td' ? `1px solid ${borders.inside.color}` : ''],
    ]);
    const attrs = (cell.colspan > 1 ? ` colspan="${cell.colspan}"` : '') + (cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : '');
    const style = css ? ` style="${css}"` : '';
    return `<${tag}${attrs}${style}>${cell.html}</${tag}>`;
  };
  const render = list => list.map(cells => `<tr>${cells.map(c => cellHtml(c, 'td')).join('')}</tr>`).join('');
  // 表格按 Word 的表宽排版；超出容器时可横向滚动，而不是把整页撑变形。
  const tableCss = officeStyle([
    ['border', borders && borders.edge ? `1px solid ${borders.edge.color}` : ''],
    ['width', geo.widthPx ? geo.widthPx.toFixed(0) + 'px' : ''],
    ['table-layout', geo.cols ? 'fixed' : ''],
  ]);
  const colgroup = geo.cols ? `<colgroup>${geo.cols.map(w => `<col style="width:${w}">`).join('')}</colgroup>` : '';
  const thead = headRows ? `<thead><tr>${spans[0].map(c => cellHtml(c, 'th')).join('')}</tr></thead>` : '';
  const body = render(spans.slice(headRows));
  return `<div class="docx-table-wrap"><table class="md-table docx-table"${tableCss ? ` style="${tableCss}"` : ''}>${colgroup}${thead}<tbody>${body}</tbody></table></div>`;
}
// 分页标记：先拼成一段 HTML，再按它切页，避免在递归渲染里传递「当前第几页」。
const DOCX_PAGE_BREAK = '<div class="docx-page-break"></div>';
// 页面设置：Word 按「页」排版，版心宽度决定每一行在哪里断行。用容器宽度直接排，
// 断行位置和原文对不上，整页看起来就是「乱」。这里取 pgSz/pgMar 还原版心，
// 显式分页符（w:br type=page）切成独立页。
function docxPageMetrics(sectPr) {
  const pgSz = sectPr ? sectPr.getElementsByTagName('w:pgSz')[0] : null;
  const pgMar = sectPr ? sectPr.getElementsByTagName('w:pgMar')[0] : null;
  const num = (el, attr, fallback) => {
    const v = officeTwipsPx(el && el.getAttribute(attr));
    return v > 0 ? v : fallback;
  };
  const width = num(pgSz, 'w:w', 11906 / 15);      // 默认 A4
  const height = num(pgSz, 'w:h', 16838 / 15);
  const top = num(pgMar, 'w:top', 1440 / 15);
  const right = num(pgMar, 'w:right', 1440 / 15);
  const bottom = num(pgMar, 'w:bottom', 1440 / 15);
  const left = num(pgMar, 'w:left', 1440 / 15);
  return {
    width, height, top, right, bottom, left,
    contentWidth: Math.max(120, width - left - right),
  };
}
// 块级遍历带预算：超长文档（几万段）整篇渲染会拼出几 MB HTML 并让主线程
// 停一秒以上，这里到量即停，由调用方补一句「只显示前 N 段」。
function docxBlocksHtml(nodes, ctx) {
  const out = [];
  let pendingList = [];
  const flushList = () => { if (pendingList.length) { out.push(docxListHtml(pendingList, ctx)); pendingList = []; } };
  const take = () => {
    if (ctx.budget.blocks >= OFFICE_LIMITS.docxBlocks) { ctx.budget.truncated = true; return false; }
    ctx.budget.blocks++;
    return true;
  };
  for (const el of nodes) {
    if (ctx.budget.truncated) break;
    const tag = el.tagName;
    if (tag === 'w:p') {
      const para = docxParagraph(el, ctx);
      if (!para) continue;
      // 段落里可能夹着显式分页符：先落页，再把标记交出去。
      if (para.html.indexOf(DOCX_PAGE_BREAK) >= 0) {
        flushList();
        const parts = para.html.split(DOCX_PAGE_BREAK);
        parts.forEach((part, index) => {
          if (index > 0) out.push(DOCX_PAGE_BREAK);
          if (!part.trim()) return;
          out.push(`<p class="docx-p"${para.css ? ` style="${para.css}"` : ''}>${part}</p>`);
        });
        ctx.budget.blocks++;
        continue;
      }
      if (!take()) break;
      if (para.list) { pendingList.push(para); continue; }
      flushList();
      if (para.heading) {
        // 标题的自动编号（"5.3.1"）作为前缀，和 Word 一致地顶在标题文字前面。
        const prefix = para.marker && !para.marker.bullet ? `<span class="docx-h-num">${esc(para.marker.text)}</span>` : '';
        out.push(`<h${para.heading}${para.css ? ` style="${para.css}"` : ''}>${prefix}${para.html}</h${para.heading}>`);
      } else {
        out.push(`<p class="docx-p${para.leaderTab ? ' docx-p-flex' : ''}"${para.css ? ` style="${para.css}"` : ''}>${para.html}</p>`);
      }
    } else if (tag === 'w:tbl') {
      flushList();
      const table = docxTableHtml(el, ctx);
      if (table) out.push(table);
    } else if (tag === 'w:sdt') {
      const content = el.getElementsByTagName('w:sdtContent')[0];
      if (content) out.push(docxBlocksHtml([...content.children], ctx));
    } else if (tag === 'w:sectPr' || tag === 'w:bookmarkStart' || tag === 'w:bookmarkEnd') {
      continue;
    } else if (el.children && el.children.length) {
      out.push(docxBlocksHtml([...el.children], ctx));
    }
  }
  flushList();
  return out.join('');
}
// 把正文按顶层块边界切成若干片，每片自己闭合 w:body，可独立解析。
// 一次交给 DOMParser 的 XML 越大，主线程停得越久（实测约 0.27ms/KB：6.6MB
// 的正文就是 1.8 秒纯停顿），而且没法中断。切片之后每片停顿可控、能中途让出
// 主线程刷新进度，预览也是边解析边出现——代价只是每片重复解析一小段头部。
// 切点只取顶层块的结束标签，表格/内容控件不会被切开。
function docxSliceBody(xml, maxBytes) {
  const bodyMatch = /<w:body\b[^>]*>/.exec(xml);
  const bodyEnd = xml.lastIndexOf('</w:body>');
  if (!bodyMatch || bodyEnd < 0) return [xml];
  const start = bodyMatch.index + bodyMatch[0].length;
  const head = xml.slice(0, start);
  const tail = '</w:body></w:document>';
  const slices = [];
  const tagRe = /<(\/?)(w:p|w:tbl|w:sdt|w:tr|w:tc)\b[^>]*?(\/?)>/g;
  tagRe.lastIndex = start;
  let depth = 0;
  let from = start;
  let match;
  while ((match = tagRe.exec(xml))) {
    const close = match[1] === '/';
    const name = match[2];
    if (match[3] === '/') continue;                 // 自闭合元素不改变嵌套
    if (!close) { if (name !== 'w:p') depth++; continue; }
    if (name !== 'w:p') {
      depth--;
      if (name !== 'w:tbl' || depth !== 0) continue;  // 顶层表格结束才算一块
    } else if (depth > 0) continue;                 // 表格/内容控件里的段落不是顶层块
    if (tagRe.lastIndex - from >= maxBytes) {
      slices.push(head + xml.slice(from, tagRe.lastIndex) + tail);
      from = tagRe.lastIndex;
    }
  }
  if (from < bodyEnd) slices.push(head + xml.slice(from, bodyEnd) + tail);
  return slices.length ? slices : [xml];
}
function docxSliceHtml(sliceXml, ctx) {
  const doc = officeParseXml(sliceXml);
  const body = doc.getElementsByTagName('w:body')[0] || doc.documentElement;
  return body ? docxBlocksHtml([...body.children], ctx) : '';
}
async function docxToHtml(zip, opts) {
  const progress = (opts && opts.onProgress) || (() => {});
  progress('正在解析 Word 文档…');
  // 解压前先看正文大小：几十 MB 的 document.xml 光是解压就会吃掉内存和主线程。
  const declared = officeEntrySize(zip, 'word/document.xml');
  if (declared > OFFICE_LIMITS.docxXmlHardBytes) {
    throw new Error(`文档正文过大（解压后约 ${(declared / 1048576).toFixed(0)} MB），无法在线预览，请在系统中打开`);
  }
  const raw = await officeReadText(zip, 'word/document.xml');
  if (!raw) throw new Error('不是有效的 Word 文档（缺少 word/document.xml）');
  await officeYield();
  const rels = await officeRels(zip, 'word/document.xml');
  const media = officeMediaStore(zip, opts && opts.mediaUrl);
  await officePreloadImages(zip, rels, media, progress);
  const table = docxStyles(await officeReadXml(zip, 'word/styles.xml'));
  const numbering = docxNumbering(await officeReadXml(zip, 'word/numbering.xml'));
  // 页面版心来自最后一个 sectPr（分节文档里末节决定整体观感）；
  // 拿不到就按 A4 + 2.54cm 页边距，和 Word 默认一致。
  const sectPr = /<w:sectPr[\s\S]*?<\/w:sectPr>/g;
  const sectMatches = raw.match(sectPr) || [];
  const page = docxPageMetrics(sectMatches.length ? officeParseXml(sectMatches[sectMatches.length - 1]).documentElement : null);
  const ctx = {
    rels, media, table, defaults: table.defaults, numbering,
    budget: { blocks: 0, truncated: false }, counters: new Map(), page, contentWidth: page.contentWidth,
  };
  const slices = docxSliceBody(raw, OFFICE_LIMITS.docxSliceBytes);
  let html = '';
  for (const [index, slice] of slices.entries()) {
    if (slices.length > 1) progress(`正在解析文档 ${index + 1}/${slices.length}…`);
    html += docxSliceHtml(slice, ctx);
    if (ctx.budget.truncated || index < slices.length - 1) await officeYield();
    if (ctx.budget.truncated) break;
  }
  // 按分页符切页：每页一个定宽「纸面」，版心宽度 = 页宽 − 左右页边距。
  // 这样断行位置才和 Word 一致（目录、表格对齐都依赖它）。
  const pageStyle = `width:${page.width.toFixed(0)}px;min-height:${page.height.toFixed(0)}px;padding:${page.top.toFixed(0)}px ${page.right.toFixed(0)}px ${page.bottom.toFixed(0)}px ${page.left.toFixed(0)}px`;
  const pages = html.split(DOCX_PAGE_BREAK)
    .map(part => `<div class="docx-page-wrap"><div class="docx-page" data-docx-w="${page.width.toFixed(0)}" data-docx-h="${page.height.toFixed(0)}" style="${pageStyle}">${part}</div></div>`)
    .join('');
  const notes = [];
  if (media.skipped()) notes.push(`${media.skipped()} 张图片超出内联上限，未显示`);
  if (ctx.budget.truncated) notes.push(`文档过长，仅显示前 ${OFFICE_LIMITS.docxBlocks} 段`);
  return `<div class="docx-doc">${pages}</div>${officeNote(notes.length ? notes.join('；') + '，完整内容请在系统中打开' : '')}`;
}

// ---------------------------------------------------------------- XLSX ----

// 内置日期格式编号（ECMA-376 附录）：14-22、27-36、45-47、50-58 都按日期显示。
const XLSX_BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
function xlsxIsDateFormat(id, codes) {
  if (XLSX_BUILTIN_DATE_FMT.has(id)) return true;
  const code = codes.get(id);
  if (!code) return false;
  // 去掉引号包裹的字面量与转义，剩下的 y/m/d/h/s 才算日期令牌；
  // 只看 m 会把 "0.00m" 之类误判成日期，所以要求至少出现 y 或 d。
  const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  return /[yd]/i.test(bare) && /[ymdhs]/i.test(bare);
}
function xlsxStyles(doc) {
  const out = { fonts: [], fills: [], xfs: [], codes: new Map() };
  if (!doc) return out;
  for (const fmt of doc.getElementsByTagName('numFmt')) {
    const id = Number(fmt.getAttribute('numFmtId'));
    if (Number.isFinite(id)) out.codes.set(id, fmt.getAttribute('formatCode') || '');
  }
  const fontsHost = doc.getElementsByTagName('fonts')[0];
  for (const f of fontsHost ? fontsHost.children : []) {
    if (f.tagName !== 'font') continue;
    const colorEl = f.getElementsByTagName('color')[0];
    out.fonts.push({
      b: !!f.getElementsByTagName('b').length,
      i: !!f.getElementsByTagName('i').length,
      u: !!f.getElementsByTagName('u').length,
      strike: !!f.getElementsByTagName('strike').length,
      color: colorEl ? officeArgHex(colorEl.getAttribute('rgb')) : '',
      size: officeHalfPtPx((f.getElementsByTagName('sz')[0] || { getAttribute: () => '' }).getAttribute('w:val') || (f.getElementsByTagName('sz')[0] || { getAttribute: () => '' }).getAttribute('val')),
      name: ((f.getElementsByTagName('name')[0] || { getAttribute: () => '' }).getAttribute('val') || ''),
    });
  }
  const fillsHost = doc.getElementsByTagName('fills')[0];
  for (const f of fillsHost ? fillsHost.children : []) {
    if (f.tagName !== 'fill') continue;
    const pattern = f.getElementsByTagName('patternFill')[0];
    const type = pattern ? (pattern.getAttribute('patternType') || '') : '';
    const fg = pattern ? pattern.getElementsByTagName('fgColor')[0] : null;
    out.fills.push({
      pattern: type,
      color: fg ? (officeArgHex(fg.getAttribute('rgb')) || '') : '',
    });
  }
  const xfsHost = doc.getElementsByTagName('cellXfs')[0];
  for (const xf of xfsHost ? xfsHost.children : []) {
    if (xf.tagName !== 'xf') continue;
    const alignment = xf.getElementsByTagName('alignment')[0];
    out.xfs.push({
      numFmtId: officeClamp(xf.getAttribute('numFmtId'), 0, 999, 0),
      fontId: officeClamp(xf.getAttribute('fontId'), 0, 999, 0),
      fillId: officeClamp(xf.getAttribute('fillId'), 0, 999, 0),
      align: alignment ? (alignment.getAttribute('horizontal') || '') : '',
      wrap: alignment ? /1|true/i.test(alignment.getAttribute('wrapText') || '') : false,
    });
  }
  return out;
}
// Excel 序列号 → 文本。25569 = 1970-01-01；1904 工作簿整体偏移 1462 天。
// 序列号没有时区概念，必须按 UTC 取字段：用本地时间在 UTC-5 之类时区会整体差一天。
function xlsxSerialToText(serial, code, date1904) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return '';
  const days = n + (date1904 ? 1462 : 0);
  const ms = Math.round((days - 25569) * 86400000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  const bare = String(code || '').replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  const p2 = v => String(v).padStart(2, '0');
  // 有时分秒令牌就带时间（注意 "mm" 既可能是月也可能是分，所以先剔年月日再找 h/s）；
  // 纯日期格式不该在日期后面缀一个 00:00。
  const withTime = /[hs]/i.test(bare.replace(/[ymd]/gi, ''));
  const base = `${date.getUTCFullYear()}-${p2(date.getUTCMonth() + 1)}-${p2(date.getUTCDate())}`;
  return withTime ? `${base} ${p2(date.getUTCHours())}:${p2(date.getUTCMinutes())}` : base;
}
function xlsxCellText(cell, shared, styles, date1904) {
  const type = cell.getAttribute('t') || '';
  const vEl = cell.getElementsByTagName('v')[0];
  const raw = vEl ? vEl.textContent : '';
  const isEl = cell.getElementsByTagName('is')[0];
  const xf = styles.xfs[officeClamp(cell.getAttribute('s'), 0, 9999, 0)];
  if (type === 's') return { text: shared[Number(raw)] ?? '', xf };
  if (type === 'inlineStr') {
    return { text: isEl ? [...isEl.getElementsByTagName('t')].map(t => t.textContent).join('') : '', xf };
  }
  if (type === 'str') return { text: raw, xf };                       // 公式的字符串结果
  if (type === 'b') return { text: raw === '1' ? 'TRUE' : 'FALSE', xf };
  if (type === 'e') return { text: raw, xf, error: true };
  if (type === 'd') return { text: String(raw).replace('T', ' ').slice(0, 16), xf };  // ISO 日期
  if (xf && xlsxIsDateFormat(xf.numFmtId, styles.codes)) {
    const text = xlsxSerialToText(raw, styles.codes.get(xf.numFmtId), date1904);
    return { text, xf };
  }
  return { text: raw, xf };
}
function xlsxCellCss(xf, styles) {
  if (!xf) return '';
  const font = styles.fonts[xf.fontId] || {};
  const fill = styles.fills[xf.fillId] || {};
  const solid = /solid/i.test(fill.pattern) && fill.color ? fill.color : '';
  return officeStyle([
    ['font-weight', font.b ? '700' : ''],
    ['font-style', font.i ? 'italic' : ''],
    ['text-decoration', [font.u ? 'underline' : '', font.strike ? 'line-through' : ''].filter(Boolean).join(' ')],
    ['color', font.color || ''],
    ['font-size', font.size ? font.size.toFixed(1) + 'px' : ''],
    ['background-color', solid],
    ['text-align', ['left', 'center', 'right'].includes(xf.align) ? xf.align : ''],
  ]);
}
function xlsxColIndex(ref) {
  const m = /^([A-Z]+)/.exec(String(ref || '').toUpperCase());
  if (!m) return -1;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c - 1;
}
async function xlsxToHtml(zip, opts) {
  const progress = (opts && opts.onProgress) || (() => {});
  progress('正在解析表格…');
  const wb = await officeReadXml(zip, 'xl/workbook.xml');
  if (!wb) throw new Error('不是有效的 Excel 文件（缺少 xl/workbook.xml）');
  const styles = xlsxStyles(await officeReadXml(zip, 'xl/styles.xml'));
  const rels = await officeRels(zip, 'xl/workbook.xml');
  const date1904 = /1|true/i.test((wb.getElementsByTagName('workbookPr')[0] || { getAttribute: () => '' }).getAttribute('date1904') || '');
  const shared = [];
  const ssFile = zip.file('xl/sharedStrings.xml');
  if (ssFile) {
    const ss = officeParseXml(await ssFile.async('string'));
    // si 里可能有多个 r（富文本分片），全部拼起来才是完整字符串。
    for (const si of ss.getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
  }
  // 工作表顺序与名字以 workbook.xml + rels 为准；直接数 sheetN.xml 在删过
  // 工作表、或 sheet 编号不连续的文件里会错位甚至漏表。
  const sheetNodes = [...wb.getElementsByTagName('sheet')];
  const sheets = [];
  for (const [index, node] of sheetNodes.entries()) {
    const rid = node.getAttribute('r:id') || '';
    const rel = rid ? rels.get(rid) : null;
    const name = node.getAttribute('name') || `Sheet${index + 1}`;
    let target = rel && !rel.external ? rel.target : '';
    let path = target ? (target.startsWith('xl/') ? target : 'xl/' + target) : '';
    // rels 缺失或指向不存在的部件时按序号兜底：有些生成器不写 rels，
    // 那样整张表会变成空白，比多猜一步糟糕得多。
    if (!path || !zip.file(path)) {
      const guess = `xl/worksheets/sheet${index + 1}.xml`;
      if (zip.file(guess)) path = guess;
    }
    sheets.push({ name, path });
  }
  if (!sheets.length) {
    for (const p of Object.keys(zip.files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()) {
      sheets.push({ name: p.replace(/\D/g, '') || '1', path: p });
    }
  }
  const MAXR = OFFICE_LIMITS.xlsxRows, MAXC = OFFICE_LIMITS.xlsxCols;
  const shownSheets = sheets.slice(0, OFFICE_LIMITS.xlsxSheets);
  const oversized = [];
  const out = [];
  let truncated = false;
  for (const [sheetIndex, sheet] of shownSheets.entries()) {
    if (shownSheets.length > 2) progress(`正在解析工作表 ${sheetIndex + 1}/${shownSheets.length}…`);
    const f = sheet.path ? zip.file(sheet.path) : null;
    if (!f) continue;
    // 单张表也可能有几百万行：解压前先看大小，超限的表直接跳过并说明。
    if (officeEntrySize(zip, sheet.path) > OFFICE_LIMITS.partXmlBytes) {
      oversized.push(sheet.name);
      continue;
    }
    const d = officeParseXml(await f.async('string'));
    // 每张表解析完让出一次，几十张表的文件也不会把主线程占满。
    await officeYield();
    const merges = new Map();      // 被合并覆盖的单元格 → 归属的左上角
    const anchors = new Map();     // 左上角 → {colspan,rowspan}
    const mergeHost = d.getElementsByTagName('mergeCells')[0];
    for (const mc of mergeHost ? mergeHost.getElementsByTagName('mergeCell') : []) {
      const [from, to] = String(mc.getAttribute('ref') || '').split(':');
      const c1 = xlsxColIndex(from), r1 = Number(String(from).replace(/[A-Z]+/i, '')) - 1;
      const c2 = xlsxColIndex(to), r2 = Number(String(to).replace(/[A-Z]+/i, '')) - 1;
      if (c1 < 0 || c2 < 0 || !Number.isFinite(r1) || !Number.isFinite(r2)) continue;
      anchors.set(r1 + ':' + c1, { colspan: Math.min(c2 - c1 + 1, MAXC), rowspan: Math.min(r2 - r1 + 1, 24) });
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) { if (r !== r1 || c !== c1) merges.set(r + ':' + c, true); }
    }
    // 列宽：col@width 单位是「字符数」，96dpi 下约 7px/字符。
    const widths = new Map();
    for (const col of d.getElementsByTagName('col')) {
      const width = Number(col.getAttribute('width'));
      const min = Number(col.getAttribute('min')), max = Number(col.getAttribute('max'));
      if (!Number.isFinite(width) || width <= 0) continue;
      const px = Math.min(420, Math.max(28, Math.round(width * 7 * 96 / 96)));
      for (let c = (Number.isFinite(min) ? min : 1) - 1; c < (Number.isFinite(max) ? max : min) && c < MAXC; c++) widths.set(c, px);
    }
    const rows = [...d.getElementsByTagName('row')];
    if (rows.length > MAXR) truncated = true;
    const body = [];
    rows.slice(0, MAXR).forEach((row, ri) => {
      const cells = new Map();
      let width = 0;
      for (const c of row.getElementsByTagName('c')) {
        const ci = xlsxColIndex(c.getAttribute('r'));
        if (ci < 0 || ci >= MAXC) continue;
        if (merges.has(ri + ':' + ci)) continue;
        const { text, xf, error } = xlsxCellText(c, shared, styles, date1904);
        const anchor = anchors.get(ri + ':' + ci);
        const css = officeStyle([
          ['text-align', anchor && anchor.colspan > 1 ? 'center' : ''],
          ['vertical-align', anchor ? 'middle' : ''],
        ]);
        const attrs = (anchor && anchor.colspan > 1 ? ` colspan="${anchor.colspan}"` : '') + (anchor && anchor.rowspan > 1 ? ` rowspan="${anchor.rowspan}"` : '');
        const inner = error ? `<span class="xlsx-error">${esc(text)}</span>` : esc(text);
        cells.set(ci, { html: inner, css: [xlsxCellCss(xf, styles), css].filter(Boolean).join(';'), attrs, ci });
        width = Math.max(width, ci + 1);
      }
      if (!cells.size) { body.push('<tr></tr>'); return; }
      const tds = [];
      for (let c = 0; c < width; c++) {
        const cell = cells.get(c);
        if (!cell) { tds.push('<td></td>'); continue; }
        tds.push(`<td${cell.attrs}${cell.css ? ` style="${cell.css}"` : ''}>${cell.html}</td>`);
      }
      body.push(`<tr>${tds.join('')}</tr>`);
    });
    const cols = widths.size
      ? `<colgroup>${Array.from({ length: Math.max(...widths.keys()) + 1 }, (_, c) => `<col${widths.has(c) ? ` style="width:${widths.get(c)}px"` : ''}>`).join('')}</colgroup>`
      : '';
    out.push(`<h4 class="xlsx-sheet">${esc(sheet.name)}</h4>`
      + `<div class="table-wrap"><table class="md-table xlsx-table"><tbody>${body.join('')}</tbody></table></div>`);
  }
  const notes = [];
  if (truncated) notes.push(`超过 ${MAXR} 行的部分`);
  if (oversized.length) notes.push(`${oversized.join('、')}（表过大）`);
  if (sheets.length > shownSheets.length) notes.push(`第 ${shownSheets.length + 1} 张之后的 ${sheets.length - shownSheets.length} 张工作表`);
  out.push(officeNote(notes.length ? `未显示：${notes.join('、')}（可在系统中打开查看完整内容）` : '已按原表样式渲染'));
  return out.join('');
}

// ---------------------------------------------------------------- PPTX ----

// pptx 里颜色大多是主题色（schemeClr val="tx1"），必须回到 theme + clrMap
// 才能换算成十六进制；否则整页文字都会变成默认黑/白，
// 深色背景的幻灯片会直接看不见字。
const PPTX_SCHEME_FALLBACK = {
  dk1: '#000000', lt1: '#ffffff', dk2: '#44546a', lt2: '#e7e6e6',
  tx1: '#000000', bg1: '#ffffff', tx2: '#44546a', bg2: '#e7e6e6',
  accent1: '#4472c4', accent2: '#ed7d31', accent3: '#a5a5a5', accent4: '#ffc000',
  accent5: '#5b9bd5', accent6: '#70ad47', hlink: '#0563c1', folHlink: '#954f72',
};
function pptxTheme(doc) {
  const colors = new Map();
  if (doc) {
    const scheme = doc.getElementsByTagName('a:clrScheme')[0];
    for (const child of scheme ? scheme.children : []) {
      const name = child.tagName.replace(/^a:/, '');
      const value = child.getElementsByTagName('a:srgbClr')[0] || child.getElementsByTagName('a:sysClr')[0];
      const hex = value ? (officeHex(value.getAttribute('val')) || officeHex(value.getAttribute('lastClr'))) : '';
      if (hex) colors.set(name, hex);
    }
  }
  return colors;
}
function pptxClrMap(doc) {
  const map = new Map();
  if (doc) {
    const host = doc.getElementsByTagName('p:clrMap')[0];
    for (const attr of host ? Array.from(host.attributes) : []) map.set(attr.name, attr.value);
  }
  return map;
}
function pptxSchemeColor(name, ctx) {
  const mapped = ctx.clrMap.get(name) || name;
  return ctx.theme.get(mapped) || ctx.theme.get(name) || PPTX_SCHEME_FALLBACK[mapped] || PPTX_SCHEME_FALLBACK[name] || '';
}
// 取直接子级里的填充色：a:solidFill 里可能是 srgbClr / schemeClr / prstClr / sysClr。
function pptxFillColor(host, ctx) {
  if (!host) return '';
  const solid = host.getElementsByTagName('a:solidFill')[0];
  if (!solid) return '';
  const srgb = solid.getElementsByTagName('a:srgbClr')[0];
  if (srgb) return officeHex(srgb.getAttribute('val'));
  const scheme = solid.getElementsByTagName('a:schemeClr')[0];
  if (scheme) return pptxSchemeColor(scheme.getAttribute('val') || '', ctx);
  const preset = solid.getElementsByTagName('a:prstClr')[0];
  if (preset) return officeHex(preset.getAttribute('val')) || '';
  const sys = solid.getElementsByTagName('a:sysClr')[0];
  if (sys) return officeHex(sys.getAttribute('lastClr')) || '';
  return '';
}
function pptxTextColor(rPr, ctx) {
  const hex = pptxFillColor(rPr, ctx);
  if (hex) return hex;
  return '';
}
// 与 docx 同理：西文与东亚字面分开声明，合成字体栈一次交给 CSS。
function pptxFontStack(rPr) {
  if (!rPr) return '';
  const faces = [];
  for (const tag of ['a:latin', 'a:ea', 'a:cs']) {
    const el = rPr.getElementsByTagName(tag)[0];
    const face = docxFontFace(el ? el.getAttribute('typeface') : '');
    if (face && !faces.includes(face)) faces.push(face);
  }
  return officeFontStack(faces);
}
function pptxRunProps(rPr, fallbackSize) {
  const out = { size: fallbackSize || 0 };
  if (!rPr) return out;
  const sz = Number(rPr.getAttribute('sz'));
  if (Number.isFinite(sz) && sz > 0) out.size = sz / 100;
  const b = rPr.getAttribute('b');
  if (b != null) out.b = /1|true/.test(b);
  const i = rPr.getAttribute('i');
  if (i != null) out.i = /1|true/.test(i);
  const u = rPr.getAttribute('u');
  if (u != null) out.u = !/none/.test(u);
  const strike = rPr.getAttribute('strike');
  if (strike != null) out.strike = !/noStrike/.test(strike);
  const caps = rPr.getAttribute('cap');
  if (caps && caps !== 'none') out.caps = caps;
  const base = Number(rPr.getAttribute('baseline'));
  if (Number.isFinite(base) && base !== 0) out.vert = base > 0 ? 'super' : 'sub';
  return out;
}
function pptxRunsHtml(p, ctx, fallback) {
  const out = [];
  for (const node of p.children) {
    if (node.tagName === 'a:r' || node.tagName === 'a:fld') {
      const rPr = node.getElementsByTagName('a:rPr')[0];
      const props = { ...(fallback || {}), ...pptxRunProps(rPr, fallback && fallback.size) };
      const text = [...node.getElementsByTagName('a:t')].map(t => t.textContent).join('');
      if (!text) continue;
      const color = pptxTextColor(rPr, ctx) || (fallback && fallback.color) || '';
      const css = officeStyle([
        ['font-weight', props.b ? '700' : ''],
        ['font-style', props.i ? 'italic' : ''],
        ['text-decoration', [props.u ? 'underline' : '', props.strike ? 'line-through' : ''].filter(Boolean).join(' ')],
        ['color', color],
        ['font-size', props.size ? (props.size * 96 / 72).toFixed(1) + 'px' : ''],
        ['font-family', pptxFontStack(rPr)],
        ['vertical-align', props.vert || ''],
        ['text-transform', props.caps === 'all' ? 'uppercase' : ''],
      ]);
      out.push(css ? `<span style="${css}">${esc(text)}</span>` : esc(text));
    } else if (node.tagName === 'a:br') {
      out.push('<br>');
    }
  }
  return out.join('');
}
// 段落默认字号：本段 defRPr → 形状默认 → 布局占位符 lstStyle → 母版 1200(18pt)。
function pptxParaSize(pPr, ctx, shapeDefault) {
  const own = pPr ? pPr.getElementsByTagName('a:defRPr')[0] : null;
  const ownSz = own ? Number(own.getAttribute('sz')) : NaN;
  if (Number.isFinite(ownSz) && ownSz > 0) return ownSz / 100;
  const lvl = Number(pPr ? pPr.getAttribute('lvl') : 0) || 0;
  if (ctx.lstStyle) {
    const lvlPr = ctx.lstStyle.get(lvl);
    if (lvlPr) return lvlPr;
  }
  return shapeDefault || 18;
}
function pptxParagraphsHtml(txBody, ctx) {
  const out = [];
  const paras = [...txBody.children].filter(c => c.tagName === 'a:p');
  for (const [index, p] of paras.entries()) {
    const pPr = p.getElementsByTagName('a:pPr')[0];
    const size = pptxParaSize(pPr, ctx, ctx.shapeDefault);
    const html = pptxRunsHtml(p, ctx, { size, color: ctx.defaultColor });
    if (!html.trim()) continue;
    const algn = pPr ? (pPr.getAttribute('algn') || '') : '';
    const marL = officeEmuPx(pPr && pPr.getAttribute('marL'));
    const indent = officeEmuPx(pPr && pPr.getAttribute('indent'));
    const buChar = pPr ? pPr.getElementsByTagName('a:buChar')[0] : null;
    const buAuto = pPr ? pPr.getElementsByTagName('a:buAutoNum')[0] : null;
    const buNone = pPr ? pPr.getElementsByTagName('a:buNone')[0] : null;
    let bullet = '';
    if (buNone) bullet = '';
    else if (buChar) bullet = buChar.getAttribute('char') || '•';
    else if (buAuto) bullet = (index + 1) + '.';
    const css = officeStyle([
      ['text-align', algn === 'ctr' ? 'center' : (algn === 'r' ? 'right' : (algn === 'just' ? 'justify' : ''))],
      ['margin-left', marL > 1 ? marL.toFixed(0) + 'px' : ''],
      ['text-indent', indent ? indent.toFixed(0) + 'px' : ''],
    ]);
    const marker = bullet ? `<span class="pptx-bu">${esc(bullet)}</span>` : '';
    out.push(`<p class="pptx-p"${css ? ` style="${css}"` : ''}>${marker}${html}</p>`);
  }
  return out.join('');
}
function pptxBodyAnchor(bodyPr) {
  const anchor = bodyPr ? (bodyPr.getAttribute('anchor') || '') : '';
  if (anchor === 'ctr') return 'center';
  if (anchor === 'b') return 'flex-end';
  return 'flex-start';
}
// 占位符位置继承：slide 上的 p:sp 常常没有 a:xfrm，尺寸和位置都在版式里。
function pptxPlaceholderLookup(tree, phType, phIdx) {
  if (!tree) return null;
  for (const sp of tree.getElementsByTagName('p:sp')) {
    const ph = sp.getElementsByTagName('p:ph')[0];
    if (!ph) continue;
    const type = ph.getAttribute('type') || 'body';
    const idx = ph.getAttribute('idx') || '';
    if ((phIdx && idx === phIdx) || (!phIdx && type === phType) || (phIdx && !idx && type === phType)) return sp;
  }
  return null;
}
function pptxShapeXfrm(sp, ctx) {
  const spPr = sp.getElementsByTagName('p:spPr')[0];
  let xfrm = spPr ? spPr.getElementsByTagName('a:xfrm')[0] : null;
  // 没有显式位置：去版式、母版里按占位符类型找，否则标题/正文会全叠在左上角。
  if (!xfrm) {
    const ph = sp.getElementsByTagName('p:ph')[0];
    if (ph) {
      const type = ph.getAttribute('type') || '';
      const idx = ph.getAttribute('idx') || '';
      const owner = pptxPlaceholderLookup(ctx.layoutTree, type, idx) || pptxPlaceholderLookup(ctx.masterTree, type, idx);
      if (owner) {
        const ownerPr = owner.getElementsByTagName('p:spPr')[0];
        xfrm = ownerPr ? ownerPr.getElementsByTagName('a:xfrm')[0] : null;
      }
    }
  }
  return xfrm;
}
function pptxXfrmCss(xfrm, scale) {
  const s = scale || { sx: 1, sy: 1, ox: 0, oy: 0 };
  const off = xfrm ? xfrm.getElementsByTagName('a:off')[0] : null;
  const ext = xfrm ? xfrm.getElementsByTagName('a:ext')[0] : null;
  const left = (officeEmuPx(off && off.getAttribute('x')) - s.ox) * s.sx;
  const top = (officeEmuPx(off && off.getAttribute('y')) - s.oy) * s.sy;
  const width = officeEmuPx(ext && ext.getAttribute('cx')) * s.sx;
  const height = officeEmuPx(ext && ext.getAttribute('cy')) * s.sy;
  const rot = xfrm ? Number(xfrm.getAttribute('rot')) : NaN;
  const flipH = xfrm ? /1|true/.test(xfrm.getAttribute('flipH') || '') : false;
  const flipV = xfrm ? /1|true/.test(xfrm.getAttribute('flipV') || '') : false;
  const transforms = [];
  if (Number.isFinite(rot) && rot) transforms.push(`rotate(${(rot / 60000).toFixed(2)}deg)`);
  if (flipH) transforms.push('scaleX(-1)');
  if (flipV) transforms.push('scaleY(-1)');
  return {
    css: officeStyle([
      ['left', left.toFixed(1) + 'px'],
      ['top', top.toFixed(1) + 'px'],
      ['width', Math.max(1, width).toFixed(1) + 'px'],
      ['height', Math.max(1, height).toFixed(1) + 'px'],
      ['transform', transforms.join(' ')],
    ]),
  };
}
function pptxShapeHtml(sp, ctx) {
  const xfrm = pptxShapeXfrm(sp, ctx);
  const geo = pptxXfrmCss(xfrm, ctx.scale);
  const spPr = sp.getElementsByTagName('p:spPr')[0];
  const fill = pptxFillColor(spPr, ctx);
  const ln = spPr ? spPr.getElementsByTagName('a:ln')[0] : null;
  const border = ln ? pptxFillColor(ln, ctx) : '';
  const body = sp.getElementsByTagName('p:txBody')[0];
  const bodyPr = body ? body.getElementsByTagName('a:bodyPr')[0] : null;
  const anchor = pptxBodyAnchor(bodyPr);
  const insets = bodyPr ? {
    l: officeEmuPx(bodyPr.getAttribute('lIns') ?? 91440),
    t: officeEmuPx(bodyPr.getAttribute('tIns') ?? 45720),
    r: officeEmuPx(bodyPr.getAttribute('rIns') ?? 91440),
    b: officeEmuPx(bodyPr.getAttribute('bIns') ?? 45720),
  } : { l: 9.6, t: 4.8, r: 9.6, b: 4.8 };
  const inner = body ? pptxParagraphsHtml(body, ctx) : '';
  if (!inner && !fill && !border) return '';
  const style = [geo.css, officeStyle([
    ['background-color', fill],
    ['border', border ? `1px solid ${border}` : ''],
    ['justify-content', anchor],
    ['padding', `${insets.t.toFixed(1)}px ${insets.r.toFixed(1)}px ${insets.b.toFixed(1)}px ${insets.l.toFixed(1)}px`],
    ['color', ctx.defaultColor || ''],
  ])].filter(Boolean).join(';');
  const box = sp.getElementsByTagName('a:prstGeom')[0];
  const round = box && /roundRect|ellipse/.test(box.getAttribute('prst') || '') ? ' pptx-round' : '';
  return `<div class="pptx-shape${round}" style="${style}">${inner}</div>`;
}
function pptxPicHtml(pic, ctx) {
  const blip = pic.getElementsByTagName('a:blip')[0];
  const rel = blip ? ctx.rels.get(blip.getAttribute('r:embed') || '') : null;
  const url = rel && !rel.external ? ctx.media.get(rel.target) : '';
  const spPr = pic.getElementsByTagName('p:spPr')[0];
  const geo = pptxXfrmCss(spPr ? spPr.getElementsByTagName('a:xfrm')[0] : null, ctx.scale);
  const cNvPr = pic.getElementsByTagName('p:cNvPr')[0];
  const alt = cNvPr ? (cNvPr.getAttribute('descr') || cNvPr.getAttribute('name') || '') : '';
  if (!url) return `<div class="pptx-shape pptx-missing" style="${geo.css}">[图片]</div>`;
  return `<img class="pptx-img" src="${esc(url)}" alt="${esc(alt)}" loading="lazy" decoding="async" style="${geo.css}">`;
}
function pptxTableHtml(frame, ctx) {
  const tbl = frame.getElementsByTagName('a:tbl')[0];
  if (!tbl) return '';
  const widths = [...tbl.getElementsByTagName('a:gridCol')].map(c => officeEmuPx(c.getAttribute('w')) * ctx.scale.sx);
  const rows = [];
  for (const tr of tbl.getElementsByTagName('a:tr')) {
    const cells = [];
    for (const tc of tr.getElementsByTagName('a:tc')) {
      const body = tc.getElementsByTagName('a:txBody')[0];
      const gridSpan = officeClamp(tc.getAttribute('gridSpan'), 1, 64, 1);
      const fill = pptxFillColor(tc.getElementsByTagName('a:tcPr')[0], ctx);
      const inner = body ? pptxParagraphsHtml(body, ctx) : '';
      cells.push({ inner, fill, gridSpan });
    }
    rows.push(cells);
  }
  const total = widths.reduce((a, b) => a + b, 0) || 1;
  const colgroup = widths.length ? `<colgroup>${widths.map(w => `<col style="width:${(w / total * 100).toFixed(2)}%">`).join('')}</colgroup>` : '';
  const body = rows.map(cells => `<tr>${cells.map(c => `<td${c.gridSpan > 1 ? ` colspan="${c.gridSpan}"` : ''}${c.fill ? ` style="background-color:${c.fill}"` : ''}>${c.inner}</td>`).join('')}</tr>`).join('');
  const geo = pptxXfrmCss(frame.getElementsByTagName('p:xfrm')[0], ctx.scale);
  return `<div class="pptx-shape pptx-table-box" style="${geo.css}"><table class="pptx-table">${colgroup}<tbody>${body}</tbody></table></div>`;
}
function pptxBackground(slideDoc, ctx) {
  for (const doc of [slideDoc, ctx.layoutDoc, ctx.masterDoc]) {
    if (!doc) continue;
    const bg = doc.getElementsByTagName('p:bg')[0];
    if (!bg) continue;
    const solid = pptxFillColor(bg.getElementsByTagName('p:bgPr')[0], ctx);
    if (solid) return solid;
    const ref = bg.getElementsByTagName('p:bgRef')[0];
    if (ref) {
      const scheme = ref.getElementsByTagName('a:schemeClr')[0];
      const srgb = ref.getElementsByTagName('a:srgbClr')[0];
      const color = srgb ? officeHex(srgb.getAttribute('val')) : (scheme ? pptxSchemeColor(scheme.getAttribute('val') || '', ctx) : '');
      if (color) return color;
    }
  }
  return '';
}
// 组合形状：子形状用 chOff/chExt 那套坐标，先按比例映射回父画布再落到 px。
// 统一用仿射 (emu - ox) * sx 表示，嵌套组合才不用为每层重算。
function pptxGroupScale(xfrm, parent) {
  const off = xfrm ? xfrm.getElementsByTagName('a:off')[0] : null;
  const ext = xfrm ? xfrm.getElementsByTagName('a:ext')[0] : null;
  const chOff = xfrm ? xfrm.getElementsByTagName('a:chOff')[0] : null;
  const chExt = xfrm ? xfrm.getElementsByTagName('a:chExt')[0] : null;
  const childW = officeEmuPx(chExt && chExt.getAttribute('cx'));
  const childH = officeEmuPx(chExt && chExt.getAttribute('cy'));
  const boxW = officeEmuPx(ext && ext.getAttribute('cx'));
  const boxH = officeEmuPx(ext && ext.getAttribute('cy'));
  const chX = officeEmuPx(chOff && chOff.getAttribute('x'));
  const chY = officeEmuPx(chOff && chOff.getAttribute('y'));
  const offX = officeEmuPx(off && off.getAttribute('x'));
  const offY = officeEmuPx(off && off.getAttribute('y'));
  const rx = childW > 0 && boxW > 0 ? boxW / childW : 1;
  const ry = childH > 0 && boxH > 0 ? boxH / childH : 1;
  return {
    sx: rx * parent.sx,
    sy: ry * parent.sy,
    ox: chX - (offX - parent.ox) / rx,
    oy: chY - (offY - parent.oy) / ry,
  };
}
function pptxShapesHtml(tree, ctx, scale) {
  if (!tree) return '';
  const local = { ...ctx, scale: scale || ctx.scale };
  const out = [];
  for (const node of tree.children) {
    if (node.tagName === 'p:sp') out.push(pptxShapeHtml(node, local));
    else if (node.tagName === 'p:pic') out.push(pptxPicHtml(node, local));
    else if (node.tagName === 'p:graphicFrame') {
      if (node.getElementsByTagName('a:tbl').length) out.push(pptxTableHtml(node, local));
      else {
        const geo = pptxXfrmCss(node.getElementsByTagName('p:xfrm')[0], local.scale);
        out.push(`<div class="pptx-shape pptx-missing" style="${geo.css}">[图表]</div>`);
      }
    } else if (node.tagName === 'p:grpSp') {
      const grpPr = node.getElementsByTagName('p:grpSpPr')[0];
      const xfrm = grpPr ? grpPr.getElementsByTagName('a:xfrm')[0] : null;
      if (!xfrm) continue;
      out.push(pptxShapesHtml(node.getElementsByTagName('p:spTree')[0], local, pptxGroupScale(xfrm, local.scale)));
    }
  }
  return out.join('');
}
// 无 spTree 的残缺幻灯片：至少把文本按段落吐出来，别整页空白。
function pptxFallbackText(doc, ctx) {
  const out = [];
  for (const p of doc.getElementsByTagName('a:p')) {
    const html = pptxRunsHtml(p, ctx, { size: ctx.shapeDefault, color: ctx.defaultColor });
    if (html.trim()) out.push(`<p class="pptx-p">${html}</p>`);
  }
  if (!out.length) return '';
  return `<div class="pptx-shape" style="left:5%;top:5%;width:90%;height:90%;justify-content:flex-start">${out.join('')}</div>`;
}
// 幻灯片上的占位符字号来自版式；把 a:lstStyle 的 lvl→sz 压成一张表备用。
function pptxLstStyleSizes(tree) {
  const sizes = new Map();
  if (!tree) return sizes;
  for (const sp of tree.getElementsByTagName('p:sp')) {
    const body = sp.getElementsByTagName('p:txBody')[0];
    const lst = body ? body.getElementsByTagName('a:lstStyle')[0] : null;
    if (!lst) continue;
    for (const lvlPr of lst.children) {
      const m = /^a:lvl(\d)pPr$/.exec(lvlPr.tagName);
      if (!m) continue;
      const def = lvlPr.getElementsByTagName('a:defRPr')[0];
      const sz = def ? Number(def.getAttribute('sz')) : NaN;
      if (Number.isFinite(sz) && sz > 0 && !sizes.has(Number(m[1]) - 1)) sizes.set(Number(m[1]) - 1, sz / 100);
    }
  }
  return sizes;
}
async function pptxToHtml(zip, opts) {
  const progress = (opts && opts.onProgress) || (() => {});
  progress('正在解析演示文稿…');
  const pres = await officeReadXml(zip, 'ppt/presentation.xml');
  const presRels = await officeRels(zip, 'ppt/presentation.xml');
  const sldSz = pres ? pres.getElementsByTagName('p:sldSz')[0] : null;
  const slideW = officeEmuPx(sldSz && sldSz.getAttribute('cx')) || 960;
  const slideH = officeEmuPx(sldSz && sldSz.getAttribute('cy')) || 540;
  // 幻灯片顺序按 presentation.xml 的 sldIdLst；直接排序 slideN.xml 在
  // 调整过页序的文件里会给出错误的页序。
  const ordered = [];
  if (pres) {
    for (const id of pres.getElementsByTagName('p:sldId')) {
      const rel = presRels.get(id.getAttribute('r:id') || '');
      if (rel && !rel.external && /slide\d+\.xml$/.test(rel.target)) ordered.push(rel.target);
    }
  }
  if (!ordered.length) {
    for (const name of Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))) ordered.push(name);
    ordered.sort((a, b) => (parseInt(a.replace(/\D/g, ''), 10) || 0) - (parseInt(b.replace(/\D/g, ''), 10) || 0));
  }
  const defaultSizes = new Map();
  if (pres) {
    const defStyle = pres.getElementsByTagName('p:defaultTextStyle')[0];
    for (const lvlPr of defStyle ? defStyle.children : []) {
      const m = /^a:lvl(\d)pPr$/.exec(lvlPr.tagName);
      if (!m) continue;
      const def = lvlPr.getElementsByTagName('a:defRPr')[0];
      const sz = def ? Number(def.getAttribute('sz')) : NaN;
      if (Number.isFinite(sz) && sz > 0) defaultSizes.set(Number(m[1]) - 1, sz / 100);
    }
  }
  const out = [];
  let skipped = 0;
  const shown = ordered.slice(0, OFFICE_LIMITS.pptxSlides);
  // 图片预算与媒体缓存整份共享：每页各建一个 store 会让预算按页重置，
  // 30 页各自内联满额图片，拼出几十 MB 的 HTML。
  const media = officeMediaStore(zip, opts && opts.mediaUrl);
  for (const [index, path] of shown.entries()) {
    progress(`正在解析第 ${index + 1}/${shown.length} 页…`);
    const doc = await officeReadXml(zip, path);
    if (!doc) continue;
    const rels = await officeRels(zip, path);
    await officePreloadImages(zip, rels, media, progress);
    const layoutRel = [...rels.values()].find(r => /slideLayout\d+\.xml$/.test(r.target));
    const layoutDoc = layoutRel ? await officeReadXml(zip, layoutRel.target) : null;
    const masterRel = layoutDoc ? [...(await officeRels(zip, layoutRel.target)).values()].find(r => /slideMaster\d+\.xml$/.test(r.target)) : null;
    const masterDoc = masterRel ? await officeReadXml(zip, masterRel.target) : null;
    const themeRel = masterRel ? [...(await officeRels(zip, masterRel.target)).values()].find(r => /theme\d+\.xml$/.test(r.target)) : null;
    const themeDoc = themeRel ? await officeReadXml(zip, themeRel.target) : null;
    const ctx = {
      rels, media, theme: pptxTheme(themeDoc), clrMap: pptxClrMap(masterDoc || layoutDoc),
      layoutDoc, masterDoc, layoutTree: layoutDoc ? layoutDoc.getElementsByTagName('p:spTree')[0] : null,
      masterTree: masterDoc ? masterDoc.getElementsByTagName('p:spTree')[0] : null,
      defaultColor: '', scale: { sx: 1, sy: 1, ox: 0, oy: 0 },
      lstStyle: defaultSizes, shapeDefault: 18,
    };
    const layoutSizes = pptxLstStyleSizes(ctx.layoutTree);
    const masterSizes = pptxLstStyleSizes(ctx.masterTree);
    ctx.lstStyle = new Map([...masterSizes, ...layoutSizes, ...defaultSizes]);
    ctx.defaultColor = pptxSchemeColor('tx1', ctx) || '';
    const tree = doc.getElementsByTagName('p:spTree')[0];
    const bg = pptxBackground(doc, ctx);
    // 没有 spTree 的文件（非标准导出/残缺文件）退回纯文本提取，
    // 总比给用户一句「没有可渲染的内容」有用。
    const inner = tree ? pptxShapesHtml(tree, ctx) : pptxFallbackText(doc, ctx);
    // 每页解析完让出一次：页面在解析过程中仍可滚动、可响应关闭。
    await officeYield();
    skipped += media.skipped();
    if (!inner && !bg) { out.push(`<div class="pptx-slide-wrap"><div class="pptx-slide pptx-empty" style="width:${slideW}px;height:${slideH}px">（第 ${index + 1} 页没有可渲染的内容）</div></div>`); continue; }
    out.push(`<div class="pptx-slide-wrap">`
      + `<div class="pptx-slide" data-pptx-w="${slideW}" data-pptx-h="${slideH}" style="width:${slideW}px;height:${slideH}px${bg ? ';background:' + bg : ''}">${inner}</div>`
      + `</div><div class="pptx-caption">第 ${index + 1} 页 / ${ordered.length}</div>`);
  }
  const notes = [];
  if (skipped) notes.push(`${skipped} 张图片超出内联上限，未显示`);
  if (ordered.length > shown.length) notes.push(`共 ${ordered.length} 页，仅显示前 ${shown.length} 页`);
  if (!out.length) return '<p class="empty-doc">（没有幻灯片）</p>';
  return `<div class="pptx-deck">${out.join('')}</div>${officeNote(notes.join('；'))}`;
}
// 幻灯片按固定像素排版，宽度不够时整体等比缩放；容器尺寸变了要重算，
// 否则预览面板一收一放就会出现滚动条或大片空白。
// 幻灯片与 Word 纸面都按固定像素尺寸排版（版心/画布尺寸来自文件本身），
// 容器放不下时整体等比缩放，而不是压缩版心——压缩会让每行断点都和原文不同。
// 容器尺寸变化要重算，否则面板一收一放就会出现滚动条或大片空白。
// 幻灯片与 Word 纸面都按固定像素尺寸排版（画布/版心尺寸来自文件本身）。
// 关键约束：**绝不在缩放路径里读 scrollHeight**。这类文档的内容高度可达几十万像素，
// 每次读取都会强制整棵子树重排；放在拖拽/窗口 resize 的回调里就是每帧一次全量布局，
// 结果是把整台机器拖死（实测过一次事故）。
// 画布宽度是固定的，所以内容高度与容器宽度无关：渲染后量一次存进 dataset，之后只用缓存。
function fitOfficeStages(root, options) {
  const scope = root && root.querySelectorAll ? root : document;
  const measure = !!(options && options.measure);
  const fit = (wrap, stage, naturalW, naturalH) => {
    if (!stage) return;
    const width = naturalW || stage.offsetWidth || 0;
    if (!width) return;
    // 高度只在明确要求测量时读一次；否则用缓存值，读不到就跳过高度设置。
    let height = naturalH || 0;
    if (!height && measure) {
      height = stage.scrollHeight || stage.offsetHeight || 0;
      if (height) stage.dataset.stageH = String(height);
    }
    if (!height) height = Number(stage.dataset.stageH) || 0;
    // 可用宽度必须取自稳定的父容器：wrap 自己的宽度是我们上一轮写进去的，
    // 再读它就会形成反馈回路——容器变窄时缩放不再跟着收缩，直接溢出。
    const parent = wrap.parentElement;
    const available = (parent && parent.clientWidth) || wrap.clientWidth;
    const scale = available > 0 ? Math.min(1, available / width) : 1;
    const scaled = width * scale;
    stage.style.transformOrigin = 'top left';
    stage.style.transform = scale < 1 ? `scale(${scale})` : '';
    // 包裹层收成缩放后的实际尺寸，居中由 margin:auto 负责；
    // 否则面板比画布宽时会在右侧留出一大块空白。
    wrap.style.width = Math.round(scaled) + 'px';
    if (height) wrap.style.height = Math.round(height * scale) + 'px';
  };
  for (const wrap of scope.querySelectorAll('.pptx-slide-wrap')) {
    const stage = wrap.querySelector('.pptx-slide');
    fit(wrap, stage, Number(stage && stage.dataset.pptxW), Number(stage && stage.dataset.pptxH));
  }
  for (const wrap of scope.querySelectorAll('.docx-page-wrap')) {
    const page = wrap.querySelector('.docx-page');
    fit(wrap, page, Number(page && page.dataset.docxW), 0);
  }
}
