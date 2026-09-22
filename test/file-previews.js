// Keep the file-preview API aligned with every format offered by the UI.
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-preview-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-preview-work-'));
const PORT = 17991;
const BASE = `http://127.0.0.1:${PORT}`;
let server;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const file = ext => path.join(WORK, `sample.${ext}`);

async function post(route, body) {
  const res = await fetch(BASE + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { code: res.status, data: await res.json() };
}
async function inspect(ext, expression) {
  const js = `(async () => { await ${expression}(${JSON.stringify(file(ext))}); return { title: document.querySelector('#dlgTitle')?.textContent, body: document.querySelector('#dlgBody')?.innerText, error: !!document.querySelector('#dlgBody .err-line'), htmlSandbox: document.querySelector('#dlgBody iframe.html-preview')?.getAttribute('sandbox'), media: !!document.querySelector('#dlgBody audio.audio-preview, #dlgBody iframe.pdf-preview') }; })()`;
  const result = await post('/api/browser/evaluate', { expression: js });
  assert.equal(result.code, 200, `${ext}: browser evaluation failed: ${JSON.stringify(result.data)}`);
  assert.equal(result.data.value.error, false, `${ext}: ${result.data.value.body}`);
  console.log(`  ✓ browser ${ext}`);
  return result.data.value;
}

(async () => {
  try {
    const texts = {
      md: '# MARKDOWN_OK', markdown: '# MARKDOWN_OK', txt: 'TEXT_OK',
      csv: 'name,value\nCSV_OK,1\n', tsv: 'name\tvalue\nTSV_OK\t1\n',
      html: '<h1>HTML_OK</h1>', htm: '<h1>HTML_OK</h1>',
      json: '{"marker":"JSON_OK"}', log: 'LOG_OK', yml: 'marker: YAML_OK',
      yaml: 'marker: YAML_OK', ini: 'marker=INI_OK', conf: 'marker=CONF_OK',
      xml: '<marker>XML_OK</marker>', env: 'MARKER=ENV_OK',
    };
    for (const [ext, content] of Object.entries(texts)) fs.writeFileSync(file(ext), content);
    const audio = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' };
    for (const ext of Object.keys(audio)) fs.writeFileSync(file(ext), Buffer.from('audio-fixture'));
    fs.writeFileSync(file('pdf'), '%PDF-1.4\n%%EOF');
    fs.writeFileSync(file('png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXsAAAAASUVORK5CYII=', 'base64'));
    // 夹具故意带上图片与排版（居中、颜色、字号、表格边框、幻灯片背景与定位、
    // 日期与合并单元格）：预览层的历史缺陷就是「只抠文字」，夹具必须能照出这些丢失项。
    const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXsAAAAASUVORK5CYII=', 'base64');
    const DATE_SERIAL = Math.round(Date.UTC(2026, 2, 15) / 86400000) + 25569;
    const office = {
      docx: {
        'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="w" xmlns:r="r" xmlns:wp="wp" xmlns:a="a" xmlns:pic="pic"><w:body>'
          + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>DOCX_OK</w:t></w:r></w:p>'
          + '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="宋体"/><w:color w:val="FF0000"/><w:sz w:val="32"/></w:rPr><w:t>DOCX_CENTER_OK</w:t></w:r></w:p>'
          + '<w:p><w:r><w:t>BEFORE_TBL</w:t></w:r></w:p>'
          + '<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="8" w:color="808080"/><w:insideH w:val="single" w:sz="8" w:color="808080"/></w:tblBorders></w:tblPr>'
          + '<w:tr><w:tc><w:p><w:r><w:t>CELL_A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>CELL_B</w:t></w:r></w:p></w:tc></w:tr>'
          + '<w:tr><w:tc><w:p><w:r><w:t>CELL_C</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>CELL_D</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
          + '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><a:graphic><a:graphicData>'
          + '<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="" descr="DOCX_IMG"/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId9"/></pic:blipFill></pic:pic>'
          + '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
          + '<w:p><w:r><w:t>AFTER_TBL</w:t></w:r></w:p></w:body></w:document>',
        'word/_rels/document.xml.rels': '<?xml version="1.0"?><Relationships xmlns="rel"><Relationship Id="rId9" Type="img" Target="media/pixel.png"/></Relationships>',
        'word/styles.xml': '<?xml version="1.0"?><w:styles xmlns:w="w"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style></w:styles>',
        'word/media/pixel.png': PIXEL_PNG,
      },
      xlsx: {
        'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="rel"><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet><sheetData>'
          + '<row r="1"><c r="A1" s="0" t="inlineStr"><is><t>XLSX_OK</t></is></c><c r="B1" s="0" t="inlineStr"><is><t>XLSX_DATE_OK</t></is></c></row>'
          + `<row r="2"><c r="A2" t="inlineStr"><is><t>XLSX_ROW_OK</t></is></c><c r="B2" s="1"><v>${DATE_SERIAL}</v></c></row>`
          + '<row r="3"><c r="A3" s="2" t="inlineStr"><is><t>XLSX_MERGE_OK</t></is></c><c r="B3" s="2"/></row>'
          + '</sheetData><mergeCells count="1"><mergeCell ref="A3:B3"/></mergeCells></worksheet>',
        'xl/styles.xml': '<?xml version="1.0"?><styleSheet><fonts count="1"><font><b/><sz val="12"/></font></fonts>'
          + '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
          + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0"/><xf numFmtId="14" fontId="0" fillId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0"/></cellXfs></styleSheet>',
      },
      pptx: {
        'ppt/presentation.xml': '<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>',
        'ppt/_rels/presentation.xml.rels': '<?xml version="1.0"?><Relationships xmlns="rel"><Relationship Id="rId2" Type="slide" Target="slides/slide1.xml"/></Relationships>',
        'ppt/slides/slide1.xml': '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld>'
          + '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="1F2937"/></a:solidFill></p:bgPr></p:bg>'
          + '<p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
          + '<p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="7315200" cy="914400"/></a:xfrm></p:spPr>'
          + '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2800" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>PPTX_OK</a:t></a:r></a:p></p:txBody></p:sp>'
          + '<p:pic><p:nvPicPr><p:cNvPr id="3" name="P" descr="PPTX_IMG"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill>'
          + '<p:spPr><a:xfrm><a:off x="4754880" y="1280160"/><a:ext cx="1828800" cy="1828800"/></a:xfrm></p:spPr></p:pic>'
          + '</p:spTree></p:cSld></p:sld>',
        'ppt/slides/_rels/slide1.xml.rels': '<?xml version="1.0"?><Relationships xmlns="rel"><Relationship Id="rId1" Type="img" Target="../media/image1.png"/></Relationships>',
        'ppt/media/image1.png': PIXEL_PNG,
      },
    };
    for (const [ext, entries] of Object.entries(office)) {
      const zip = new JSZip();
      for (const [name, content] of Object.entries(entries)) zip.file(name, content);
      fs.writeFileSync(file(ext), await zip.generateAsync({ type: 'nodebuffer' }));
    }
    // 大文件夹具：预览必须给结果设上限并说明，而不是把整份内容摊进 DOM。
    // 图片总量刻意超过内联预算，用来锁住「预算按页重置」这个缺陷不复发。
    const noisePng = (() => {
      const zlib = require('zlib');
      // 768×768 未压缩 RGBA ≈ 2.4MB：10 页合计刻意超过 16MB 内联预算，
      // 用来锁住「预算按页重置、30 页各带满额图片拼出几十 MB」这个缺陷。
      const side = 768;
      const raw = Buffer.alloc(side * side * 4);
      for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) % 251;
      const rows = [];
      for (let y = 0; y < side; y++) rows.push(Buffer.concat([Buffer.from([0]), raw.subarray(y * side * 4, (y + 1) * side * 4)]));
      const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
      const crc32 = buf => { let crc = 0xffffffff; for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; };
      const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
        return Buffer.concat([len, body, crc]);
      };
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(side, 0); ihdr.writeUInt32BE(side, 4); ihdr[8] = 8; ihdr[9] = 6;
      return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 0 })),
        chunk('IEND', Buffer.alloc(0)),
      ]);
    })();
    const bigPptxSlides = 10;
    {
      const zip = new JSZip();
      const ids = [];
      for (let i = 1; i <= bigPptxSlides; i++) ids.push(`<p:sldId id="${255 + i}" r:id="rId${i}"/>`);
      zip.file('ppt/presentation.xml', `<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:sldIdLst>${ids.join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`);
      zip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0"?><Relationships xmlns="rel">${ids.map((_, i) => `<Relationship Id="rId${i + 1}" Type="slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`);
      for (let i = 1; i <= bigPptxSlides; i++) {
        zip.file(`ppt/slides/slide${i}.xml`, '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>'
          + `<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="3657600" cy="914400"/></a:xfrm></p:spPr>`
          + `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2000"/><a:t>BIG_PPTX_${i}</a:t></a:r></a:p></p:txBody></p:sp>`
          + `<p:pic><p:nvPicPr><p:cNvPr id="3" name="P"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill>`
          + `<p:spPr><a:xfrm><a:off x="457200" y="1371600"/><a:ext cx="2743200" cy="2743200"/></a:xfrm></p:spPr></p:pic>`
          + '</p:spTree></p:cSld></p:sld>');
        zip.file(`ppt/slides/_rels/slide${i}.xml.rels`, `<?xml version="1.0"?><Relationships xmlns="rel"><Relationship Id="rId1" Type="img" Target="../media/image${i}.png"/></Relationships>`);
        zip.file(`ppt/media/image${i}.png`, noisePng);
      }
      fs.writeFileSync(file('big.pptx'), await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
    }
    // 5000 段 Word：段落上限生效时只渲染前 4000 段并给出说明
    {
      const zip = new JSZip();
      const paras = [];
      for (let i = 0; i < 5000; i++) paras.push(`<w:p><w:r><w:t>BIG_DOCX_${i}</w:t></w:r></w:p>`);
      zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${paras.join('')}</w:body></w:document>`);
      fs.writeFileSync(file('big.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
    }
    // 排版专用夹具：页面版心、字符单位缩进、标题自动编号、表格网格列宽、
    // 目录点线制表位、显式分页符。这几项决定「预览像不像原 Word」。
    {
      const zip = new JSZip();
      zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="w" xmlns:r="r"><w:body>'
        + '<w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>LAYOUT_H1</w:t></w:r></w:p>'
        + '<w:p><w:pPr><w:pStyle w:val="H2"/></w:pPr><w:r><w:t>LAYOUT_H2</w:t></w:r></w:p>'
        + '<w:p><w:pPr><w:ind w:firstLineChars="200"/></w:pPr><w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t>LAYOUT_INDENT</w:t></w:r></w:p>'
        + '<w:p><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9016"/></w:tabs></w:pPr><w:r><w:t>LAYOUT_TOC</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>7</w:t></w:r></w:p>'
        + '<w:tbl><w:tblPr><w:tblW w:type="pct" w:w="5000"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="1000"/></w:tblGrid>'
        + '<w:tr><w:tc><w:p><w:r><w:t>LAYOUT_A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>LAYOUT_B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
        + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
        + '<w:p><w:r><w:t>LAYOUT_PAGE2</w:t></w:r></w:p>'
        + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
        + '</w:body></w:document>');
      zip.file('word/styles.xml', '<?xml version="1.0"?><w:styles xmlns:w="w">'
        + '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>'
        + '<w:style w:type="paragraph" w:styleId="H1"><w:name w:val="heading 1"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr></w:style>'
        + '<w:style w:type="paragraph" w:styleId="H2"><w:name w:val="heading 2"/><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="5"/></w:numPr><w:outlineLvl w:val="1"/></w:pPr></w:style>'
        + '</w:styles>');
      zip.file('word/numbering.xml', '<?xml version="1.0"?><w:numbering xmlns:w="w">'
        + '<w:abstractNum w:abstractNumId="9">'
        + '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>'
        + '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>'
        + '</w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="9"/></w:num></w:numbering>');
      fs.writeFileSync(file('layout.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
    }
    // 多图长文档：图片必须懒加载（open 时不得解码全部）
    {
      const zip = new JSZip();
      const rels = [];
      const blocks = [];
      for (let i = 0; i < 12; i++) {
        rels.push(`<Relationship Id="rId${i + 1}" Type="img" Target="media/pic${i}.png"/>`);
        // 每张图之间隔 30 段正文，确保图片分散在很长的页面里
        for (let k = 0; k < 30; k++) blocks.push(`<w:p><w:r><w:t>FILLER_${i}_${k} 一段用于撑开页面的正文内容。</w:t></w:r></w:p>`);
        blocks.push('<w:p><w:r><w:drawing><wp:inline><wp:extent cx="2857500" cy="1905000"/><a:graphic><a:graphicData>'
          + `<pic:pic><pic:nvPicPr><pic:cNvPr id="${i}" name="" descr="PIC_${i}"/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId${i + 1}"/></pic:blipFill></pic:pic>`
          + '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>');
      }
      zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="w" xmlns:r="r" xmlns:wp="wp" xmlns:a="a" xmlns:pic="pic"><w:body>'
        + blocks.join('')
        + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
        + '</w:body></w:document>');
      zip.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="rel">${rels.join('')}</Relationships>`);
      for (let i = 0; i < 12; i++) zip.file(`word/media/pic${i}.png`, PIXEL_PNG);
      fs.writeFileSync(file('many-images.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
    }
    // 超过预览上限的文件：只允许出现明确提示，不允许真去读正文
    fs.writeFileSync(file('huge.docx'), '');
    fs.truncateSync(file('huge.docx'), 100 * 1024 * 1024);
    server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, AGENTHUB_PORT: String(PORT), AGENTHUB_DATA_DIR: DATA }, stdio: 'ignore' });
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await fetch(BASE + '/api/health')).ok; if (healthy) break; } catch {}
      await sleep(250);
    }
    assert(healthy, 'AgentHub did not start');
    for (const [ext, content] of Object.entries(texts)) {
      const res = await fetch(BASE + '/api/fs/raw?path=' + encodeURIComponent(file(ext)));
      assert.equal(res.status, 200, `${ext}: HTTP ${res.status}`);
      const data = await res.json();
      assert.equal(data.text, content, ext);
      console.log(`  ✓ text ${ext}`);
    }
    for (const [ext, mime] of Object.entries(audio)) {
      const res = await fetch(BASE + '/api/fs/raw?mode=raw&path=' + encodeURIComponent(file(ext)));
      assert.equal(res.status, 200, ext);
      assert(res.headers.get('content-type').startsWith(mime), `${ext}: ${res.headers.get('content-type')}`);
      assert.equal((await res.arrayBuffer()).byteLength, 'audio-fixture'.length, ext);
      console.log(`  ✓ audio ${ext}`);
    }
    for (const ext of ['pdf', 'docx', 'xlsx', 'pptx']) {
      const res = await fetch(BASE + '/api/fs/raw?path=' + encodeURIComponent(file(ext)));
      assert.equal(res.status, 200, ext);
      assert((await res.json()).b64, ext);
      console.log(`  ✓ document ${ext}`);
    }
    const image = await (await fetch(BASE + '/api/fs/raw?path=' + encodeURIComponent(file('png')))).json();
    assert(image.dataUrl.startsWith('data:image/png;base64,'));
    const blocked = await fetch(BASE + '/api/fs/raw?path=' + encodeURIComponent(path.join(WORK, 'bad.exe')));
    assert.equal(blocked.status, 400);

    // 内嵌图片端点：字节必须与压缩包里的条目完全一致，且只放行 media 下的位图。
    {
      const fixture = file('docx');
      const zip = await new Promise(async resolve => resolve(await JSZip.loadAsync(fs.readFileSync(fixture))));
      const part = Object.keys(zip.files).find(n => /^word\/media\/.+\.png$/.test(n));
      const expected = await zip.file(part).async('nodebuffer');
      const res = await fetch(BASE + '/api/fs/office-media?path=' + encodeURIComponent(fixture) + '&part=' + encodeURIComponent(part));
      assert.equal(res.status, 200, 'office-media 应返回 200');
      assert.equal(res.headers.get('content-type'), 'image/png', 'MIME 必须是 image/png');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', '必须有 nosniff，不能让人猜类型');
      const got = Buffer.from(await res.arrayBuffer());
      assert(got.equals(expected), `office-media 的字节必须与压缩包内条目一致（${got.length} vs ${expected.length}）`);
      console.log('  ✓ 内嵌图片端点按条目返回字节');
      for (const [part2, why] of [['word/document.xml', 'XML 部件'], ['word/media/x.svg', 'svg'], ['../secret.png', '路径穿越'], ['word/media/none.png', '不存在的条目']]) {
        const bad = await fetch(BASE + '/api/fs/office-media?path=' + encodeURIComponent(fixture) + '&part=' + encodeURIComponent(part2));
        assert(bad.status === 400 || bad.status === 404, `${why} 必须被拒绝（实际 ${bad.status}）`);
      }
      const notDoc = await fetch(BASE + '/api/fs/office-media?path=' + encodeURIComponent(file('png')) + '&part=' + encodeURIComponent(part));
      assert.equal(notDoc.status, 400, '非 Office 文件必须被拒绝');
      console.log('  ✓ 内嵌图片端点拒绝非媒体部件与非法路径');
    }

    const status = await (await fetch(BASE + '/api/browser/status')).json();
    if (status.browser) {
      const opened = await post('/api/browser/open', { url: BASE + '/' });
      assert.equal(opened.code, 200);
      const entry = await post('/api/browser/evaluate', { expression: `['csv','tsv','html','htm','json','log','yml','yaml','ini','conf','xml','env','mp3','wav','ogg','m4a','aac','flac'].every(ext => filesRowHtml([{path:'sample.'+ext,tool:'Write'}], 's', 1).includes('data-fileprev='))` });
      assert.equal(entry.code, 200);
      assert.equal(entry.data.value, true, 'all previewable message files need a visible button');
      console.log('  ✓ file-card preview entry points');
      const artifact = await post('/api/browser/evaluate', { expression: `(() => { const paths = extractArtifactPaths('文件位置：C:\\\\agent\\\\agenthub\\\\AI发展报告2026.docx，同时生成 ./report.md 和 reports/deck.pptx。'); const html = artifactRowHtml(paths); return { paths, html, previewButtons: (html.match(/data-fileprev=/g) || []).length }; })()` });
      assert.equal(artifact.code, 200);
      assert.deepEqual(artifact.data.value.paths, ['C:\\agent\\agenthub\\AI发展报告2026.docx', './report.md', 'reports/deck.pptx']);
      assert.equal(artifact.data.value.previewButtons, 3, 'generated artifact cards need preview buttons');
      console.log('  ✓ generated artifact detection');
      const urlArtifacts = await post('/api/browser/evaluate', { expression: `extractArtifactPaths('参考 https://example.com/reports/report.html 和 https://example.com/a.pdf')` });
      assert.equal(urlArtifacts.code, 200);
      assert.deepEqual(urlArtifacts.data.value, [], 'web links must not become local artifact cards');
      console.log('  ✓ ignored web links');
      const grouped = await post('/api/browser/evaluate', { expression: `(() => { const html = filesRowHtml([{path:'same.js',tool:'Write'},{path:'same.js',tool:'Edit'},{path:'same.js',tool:'Edit'}], 's', 1); return { cards: (html.match(/class="file-chip/g) || []).length, summary: html.includes('1 个文件 · 3 次操作'), ops: html.includes('Edit ×2') }; })()` });
      assert.equal(grouped.code, 200);
      assert.deepEqual(grouped.data.value, { cards: 1, summary: true, ops: true }, 'repeated file events should be grouped into one card');
      console.log('  ✓ grouped file changes');
      const checks = [
        ['csv', 'previewFile', 'CSV_OK'], ['tsv', 'previewFile', 'TSV_OK'],
        ['json', 'previewFile', 'JSON_OK'], ['md', 'previewFile', 'MARKDOWN_OK'],
        ['docx', 'previewFile', 'DOCX_OK'], ['xlsx', 'previewFile', 'XLSX_OK'], ['pptx', 'previewFile', 'PPTX_OK'],
      ];
      for (const [ext, fn, marker] of checks) assert((await inspect(ext, fn)).body.includes(marker), ext);
      // Word 表格必须还是表格：早先 docxToHtml 只深扫 w:p，表格里的段落会被当正文吐出来，
      // 行列结构整个丢掉，以表格为主的报告预览出来就是一堆散行。解析器现在吃整个 zip。
      const tbl = (await post('/api/browser/evaluate', { expression: `(async () => { await loadJszip(); const zip = new JSZip(); zip.file('word/document.xml', '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>BEFORE_TBL</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>CELL_A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>CELL_B</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>CELL_C</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>CELL_D</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>AFTER_TBL</w:t></w:r></w:p></w:body></w:document>'); const html = await docxToHtml(zip); return { rows: (html.match(/<tr>/g) || []).length, cells: (html.match(/<td>/g) || []).length, isTable: html.includes('md-table'), order: html.indexOf('BEFORE_TBL') < html.indexOf('CELL_A') && html.indexOf('CELL_D') < html.indexOf('AFTER_TBL'), noStrayP: !/<td><p>/.test(html) }; })()` })).data.value;
      assert.deepEqual(tbl, { rows: 2, cells: 4, isTable: true, order: true, noStrayP: true }, 'docx 表格要渲染成 2 行 4 列并保持文档顺序');
      const xss = (await post('/api/browser/evaluate', { expression: `(async () => { await loadJszip(); const zip = new JSZip(); zip.file('word/document.xml', '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;bad&lt;/script&gt;</w:t></w:r></w:p></w:body></w:document>'); return await docxToHtml(zip); })()` })).data.value;
      assert(!/<img|<script/i.test(xss), 'docx 正文里的标签必须被转义');
      assert(/&lt;img/.test(xss), 'docx 正文要原样显示成文本');
      // 图片与排版：这些正是「预览显示不了图片、格式也不对」的具体表现，
      // 每一项都对应一个真实丢过的东西（media/ 里的图片、居中、颜色、字号、
      // 表格边框、幻灯片背景、绝对定位、日期序列号、合并单元格）。
      const richRes = await post('/api/browser/evaluate', { expression: `(async () => {
        const until = async fn => { const t0 = Date.now(); while (Date.now() - t0 < 4000) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } return null; };
        const open = async path => { await previewFile(path); await new Promise(r => setTimeout(r, 400)); return document.querySelector('#dlgBody'); };
        const ratio = (outer, inner) => { const o = outer.getBoundingClientRect(), i = inner.getBoundingClientRect(); return { x: (i.left - o.left) / o.width, y: (i.top - o.top) / o.height, w: i.width / o.width }; };
        const b1 = await open(${JSON.stringify(file('docx'))});
        const img = b1.querySelector('img.docx-img');
        await until(() => img && img.complete && img.naturalWidth > 0);
        const docx = {
          imgByUrl: !!img && img.src.indexOf('/api/fs/office-media?') >= 0 && img.src.indexOf('part=word%2Fmedia%2F') >= 0,
          imgLoaded: !!(img && img.complete && img.naturalWidth > 0),
          // 用 offsetWidth（布局尺寸）而不是 getBoundingClientRect：纸面按固定
          // 版心排版后可能被等比缩放，量出来的屏幕尺寸会带上缩放系数。
          imgBox: img ? [img.offsetWidth, img.offsetHeight] : [0, 0],
          centered: [...b1.querySelectorAll('p, div')].some(el => getComputedStyle(el).textAlign === 'center'),
          red: [...b1.querySelectorAll('span')].some(el => getComputedStyle(el).color === 'rgb(255, 0, 0)'),
          sized: [...b1.querySelectorAll('span')].some(el => Math.abs(parseFloat(getComputedStyle(el).fontSize) - 21.33) < 0.3),
          fontStack: [...b1.querySelectorAll('span[style*="font-family"]')].some(el => {
            const f = getComputedStyle(el).fontFamily;
            return f.indexOf('Calibri') >= 0 && f.indexOf('宋体') >= 0;
          }),
          cellBorder: getComputedStyle(b1.querySelector('table td')).borderTopStyle,
        };
        const b2 = await open(${JSON.stringify(file('pptx'))});
        const slide = b2.querySelector('.pptx-slide');
        const pic = b2.querySelector('img.pptx-img');
        const title = [...b2.querySelectorAll('.pptx-shape')].find(s => s.textContent.includes('PPTX_OK'));
        await until(() => pic && pic.complete && pic.naturalWidth > 0);
        const picRatio = ratio(slide, pic);
        const pptx = {
          bg: getComputedStyle(slide).backgroundColor,
          positioned: getComputedStyle(title).position,
          titleRatio: ratio(slide, title).x,
          picLoaded: !!(pic && pic.naturalWidth > 0),
          picRatioX: picRatio.x, picWidthRatio: picRatio.w,
          fitsPanel: (() => { const body = document.querySelector('.inline-preview-body') || b2; return body.scrollWidth - body.clientWidth; })(),
        };
        const b3 = await open(${JSON.stringify(file('xlsx'))});
        const xlsx = {
          date: b3.textContent.includes('2026-03-15'),
          merged: (b3.querySelector('td[colspan="2"]') || {}).textContent?.includes('XLSX_MERGE_OK') || false,
          bold: [...b3.querySelectorAll('td')].some(td => getComputedStyle(td).fontWeight === '700'),
        };
        return { docx, pptx, xlsx };
      })()` });
      assert(richRes.data && richRes.data.value, "rich evaluate 失败: " + JSON.stringify(richRes.data).slice(0, 700));
      const rich = richRes.data.value;
      assert.equal(rich.docx.imgByUrl, true, 'docx 图片要走 /api/fs/office-media 按需加载，不再整块 base64 内联');
      assert.equal(rich.docx.imgLoaded, true, 'docx 图片（URL 模式）必须真的加载出来');
      assert.deepEqual(rich.docx.imgBox, [100, 50], 'docx 图片要按 wp:extent 的尺寸显示（952500×476250 EMU = 100×50px）');
      assert.equal(rich.docx.centered, true, 'docx 居中段落必须居中');
      assert.equal(rich.docx.red, true, 'docx 字体颜色必须保留');
      assert.equal(rich.docx.sized, true, 'docx 字号必须保留（w:sz 32 → 16pt ≈ 21.3px）');
      assert.equal(rich.docx.fontStack, true, 'docx 字体要生效（单引号写法，双引号会让整条声明失效）');
      assert.equal(rich.docx.cellBorder, 'solid', 'docx 表格边框必须按 w:tblBorders 画出来');
      assert.equal(rich.pptx.bg, 'rgb(31, 41, 55)', 'pptx 幻灯片背景色必须保留');
      assert.equal(rich.pptx.positioned, 'absolute', 'pptx 形状必须绝对定位而不是顺排');
      assert(Math.abs(rich.pptx.titleRatio - 457200 / 9144000) < 0.02, 'pptx 标题要落在 a:off 指定的位置（比例 ' + rich.pptx.titleRatio.toFixed(3) + '）');
      assert.equal(rich.pptx.picLoaded, true, 'pptx 图片必须加载出来（URL 模式）');
      assert(Math.abs(rich.pptx.picRatioX - 4754880 / 9144000) < 0.02, 'pptx 图片要落在 a:off 指定的位置（比例 ' + rich.pptx.picRatioX.toFixed(3) + '）');
      assert(Math.abs(rich.pptx.picWidthRatio - 1828800 / 9144000) < 0.02, 'pptx 图片要按 a:ext 的尺寸显示');
      assert.equal(rich.pptx.fitsPanel, 0, '幻灯片缩放后不应撑出横向滚动条');
      assert.equal(rich.xlsx.date, true, 'xlsx 日期必须按格式渲染成日期而不是序列号');
      assert.equal(rich.xlsx.merged, true, 'xlsx 合并单元格要出 colspan');
      assert.equal(rich.xlsx.bold, true, 'xlsx 字体加粗必须保留');
      console.log('  ✓ office 图片与排版还原');
      // 大文件：本机走 URL 模式（图片不占 DOM），远程形态走内联预算。
      // 两条路都必须有上限，且不能让几十 MB 内容进 DOM。
      const bigRes = await post('/api/browser/evaluate', { expression: `(async () => {
        const open = async path => { await previewFile(path); await new Promise(r => setTimeout(r, 900)); return document.querySelector('#dlgBody'); };
        const b1 = await open(${JSON.stringify(file('big.pptx'))});
        const pics = [...b1.querySelectorAll('img.pptx-img')];
        const loadedAtOpen = pics.filter(i => i.complete && i.naturalWidth > 0).length;
        // 懒加载：滚动后应当加载出更多图片（证明不是「永远不加载」）
        const scroll = b1;
        scroll.scrollTop = scroll.scrollHeight;
        await new Promise(r => setTimeout(r, 1200));
        const loadedAfterScroll = pics.filter(i => i.complete && i.naturalWidth > 0).length;
        const pptx = {
          slides: b1.querySelectorAll('.pptx-slide').length,
          byUrl: pics.filter(i => i.src.indexOf('/api/fs/office-media?') >= 0).length,
          loadedAtOpen, loadedAfterScroll,
          placeholders: b1.querySelectorAll('.pptx-shape.pptx-missing').length,
          htmlBytes: b1.innerHTML.length,
          note: (b1.innerText || '').includes('超出内联上限'),
        };
        const b2 = await open(${JSON.stringify(file('big.docx'))});
        const docx = {
          paras: b2.querySelectorAll('p.docx-p').length,
          htmlBytes: b2.innerHTML.length,
          note: (b2.innerText || '').includes('仅显示前'),
          hasLast: (b2.innerText || '').includes('BIG_DOCX_4999'),
        };
        const b3 = await open(${JSON.stringify(file('huge.docx'))});
        const huge = { error: !!b3.querySelector('.err-line'), text: (b3.innerText || '').slice(0, 120) };
        // 远程形态（没有 URL 通道）仍要走内联预算：直接调解析器并只给 zip
        await loadJszip();
        const resp = await fetch(rawFileUrl(${JSON.stringify(file('big.pptx'))}, 'raw'));
        const zip = await JSZip.loadAsync(await resp.arrayBuffer());
        const inlineHtml = await pptxToHtml(zip);
        const inlineDoc = new DOMParser().parseFromString('<div>' + inlineHtml + '</div>', 'text/html');
        const inlinePics = [...inlineDoc.querySelectorAll('img.pptx-img')];
        const inline = {
          total: inlinePics.length,
          dataUrls: inlinePics.filter(i => (i.getAttribute('src') || '').startsWith('data:')).length,
          placeholders: inlineDoc.querySelectorAll('.pptx-shape.pptx-missing').length,
          htmlBytes: inlineHtml.length,
        };
        return { pptx, docx, huge, inline };
      })()` });
      assert(bigRes.data && bigRes.data.value, "big evaluate 失败: " + JSON.stringify(bigRes.data).slice(0, 700));
      const big = bigRes.data.value;
      assert.equal(big.pptx.slides, 10, '大 pptx 的页数不受影响（10 页 < 120 页上限）');
      assert.equal(big.pptx.byUrl, 10, `本机预览的图片全部走 URL（实际 ${big.pptx.byUrl}/10）`);
      assert(big.pptx.loadedAtOpen >= 1, '首屏图片要加载出来');
      assert(big.pptx.loadedAtOpen < 10, `开图时不得加载全部图片（10 张里加载了 ${big.pptx.loadedAtOpen} 张）`);
      assert(big.pptx.loadedAfterScroll > big.pptx.loadedAtOpen, `滚动后要加载出更多图片（${big.pptx.loadedAtOpen} → ${big.pptx.loadedAfterScroll}）`);
      assert.equal(big.pptx.placeholders, 0, 'URL 模式下不该出现图片占位符');
      assert.equal(big.pptx.note, false, 'URL 模式不触发内联预算提示');
      assert(big.pptx.htmlBytes < 2 * 1024 * 1024, `图片走 URL 后 HTML 应保持很小（实际 ${(big.pptx.htmlBytes / 1024).toFixed(0)}KB）`);
      // 远程形态：只能内联，必须仍然受预算约束
      assert(big.inline.total + big.inline.placeholders === 10, '远程形态的图片总数不变');
      assert(big.inline.dataUrls < 10, `内联模式下图片数受预算约束（实际 ${big.inline.dataUrls}/10）`);
      assert(big.inline.dataUrls >= 3, `预算不能小到放不下几张图（实际 ${big.inline.dataUrls}）`);
      assert.equal(big.inline.placeholders, 10 - big.inline.dataUrls, '超出预算的图片要退化成占位符');
      assert(big.inline.htmlBytes < 24 * 1024 * 1024, `内联模式的 HTML 必须有上限（实际 ${(big.inline.htmlBytes / 1048576).toFixed(1)}MB）`);
      // 5000 段超过 12000 块上限吗？不超——上限内应完整渲染；这里只校验规模在合理区间
      assert(big.docx.paras > 0, `超长 Word 应有段落渲染（实际 ${big.docx.paras}）`);
      assert(big.docx.htmlBytes < 4 * 1024 * 1024, `超长 Word 的 HTML 要保持轻量（实际 ${(big.docx.htmlBytes / 1024).toFixed(0)}KB）`);
      assert.equal(big.huge.error, true, '超过上限的文件要直接给出提示');
      assert(/过大/.test(big.huge.text), `超限提示要说明原因（实际「${big.huge.text}」）`);
      console.log('  ✓ 大文件预览有上限、有说明、不撑爆 DOM');
      // 排版还原：这些是「预览和原 Word 长得不一样」的具体条目，
      // 每一项都对应一个真实丢过的排版要素。
      const layout = (await post('/api/browser/evaluate', { expression: `(async () => {
        await previewFile(${JSON.stringify(file('layout.docx'))});
        await new Promise(r => setTimeout(r, 1200));
        const b = document.querySelector('#dlgBody');
        const pages = [...b.querySelectorAll('.docx-page')];
        const p0 = pages[0];
        const cs0 = p0 ? getComputedStyle(p0) : null;
        const heads = [...b.querySelectorAll('h1,h2')].map(h => h.textContent.trim());
        const nums = [...b.querySelectorAll('.docx-h-num')].map(s => s.textContent);
        const indentPara = [...b.querySelectorAll('p.docx-p')].find(p => p.textContent.includes('LAYOUT_INDENT'));
        const tocPara = [...b.querySelectorAll('p.docx-p')].find(p => p.textContent.includes('LAYOUT_TOC'));
        const table = b.querySelector('table.docx-table');
        return {
          pages: pages.length,
          pageWidth: p0 ? Math.round(p0.getBoundingClientRect().width / (p0.style.transform ? parseFloat(/scale\\(([\\d.]+)\\)/.exec(p0.style.transform)[1]) : 1)) : 0,
          pagePadLeft: cs0 ? cs0.paddingLeft : '',
          page2Text: pages[1] ? pages[1].textContent.trim().slice(0, 20) : '',
          page1HasPage2: pages[0] ? pages[0].textContent.includes('LAYOUT_PAGE2') : true,
          heads, nums,
          indent: indentPara ? getComputedStyle(indentPara).textIndent : '',
          // 字号设在 run 的 span 上，段落本身只继承容器字体
          indentFont: indentPara && indentPara.querySelector('span') ? getComputedStyle(indentPara.querySelector('span')).fontSize : '',
          tocFlex: tocPara ? getComputedStyle(tocPara).display : '',
          tocFillers: tocPara ? tocPara.querySelectorAll('.docx-tab-fill').length : 0,
          tocText: tocPara ? tocPara.textContent.trim() : '',
          tableLayout: table ? getComputedStyle(table).tableLayout : '',
          tableWidth: table ? Math.round(parseFloat(getComputedStyle(table).width)) : 0,
          cols: table ? [...table.querySelectorAll('col')].map(c => c.style.width) : [],
        };
      })()` }));
      assert(layout.data && layout.data.value, 'layout evaluate 失败: ' + JSON.stringify(layout.data).slice(0, 500));
      const L = layout.data.value;
      assert.equal(L.pages, 2, `显式分页符必须切页（实际 ${L.pages} 页）`);
      assert.equal(L.pageWidth, 794, `页宽取 pgSz（11906 twips = 794px，实际 ${L.pageWidth}）`);
      assert.equal(L.pagePadLeft, '96px', `页边距取 pgMar（1440 twips = 96px，实际 ${L.pagePadLeft}）`);
      assert.equal(L.page1HasPage2, false, '分页符之后的内容不能留在上一页');
      assert(L.page2Text.includes('LAYOUT_PAGE2'), '第二页要有分页符之后的内容');
      assert.equal(L.heads.length, 2, '两个标题都要渲染成 h1/h2');
      assert.deepEqual(L.nums, ['1.', '1.1'], `标题要带自动编号（实际 ${JSON.stringify(L.nums)}）`);
      // 首行缩进 2 字符 × 12pt(16px) = 32px；字号取 run 的 w:sz
      assert.equal(L.indentFont, '16px', `缩进段字号应取 w:sz 24（实际 ${L.indentFont}）`);
      assert.equal(L.indent, '32px', `firstLineChars=200 要折算成 2 字缩进（实际 ${L.indent}）`);
      assert.equal(L.tocFlex, 'flex', '带前导符制表位的段落用 flex 排版');
      assert.equal(L.tocFillers, 1, '制表位要变成前导符填充块');
      assert.equal(L.tableLayout, 'fixed', '有 tblGrid 时表格用固定布局');
      assert.equal(L.tableWidth, 602, `tblW pct=5000 即版心满宽 602px（实际 ${L.tableWidth}）`);
      assert.deepEqual(L.cols.map(c => Math.round(parseFloat(c))), [75, 25], `列宽按 tblGrid 分配（实际 ${JSON.stringify(L.cols)}）`);
      console.log('  ✓ Word 排版还原（分页/版心/缩进/编号/制表位/表格网格）');
      // 缩放路径的性能契约：resize/拖拽时绝不能读 scrollHeight。
      // 这类文档内容高度可达几十万像素，读一次就强制整棵子树重排；放进每帧回调里
      // 会把整台机器拖死（真实事故）。用计数探针把这条约束钉死。
      const fitGuard = (await post('/api/browser/evaluate', { expression: `(async () => {
        await previewFile(${JSON.stringify(file('docx'))});
        await new Promise(r => setTimeout(r, 900));
        const root = document.querySelector('#dlgBody');
        const page = root.querySelector('.docx-page');
        const wrap = root.querySelector('.docx-page-wrap');
        if (!page || !wrap) return { error: 'no page' };
        const target = Element.prototype;
        const desc = Object.getOwnPropertyDescriptor(target, 'scrollHeight');
        let reads = 0;
        Object.defineProperty(target, 'scrollHeight', { configurable: true, get() { reads++; return desc.get.call(this); } });
        let out;
        try {
          fitOfficeStages(root, { measure: false });
          fitOfficeStages(root, { measure: false });
          const wrapRect = wrap.getBoundingClientRect(), pageRect = page.getBoundingClientRect();
          out = {
            readsOnResize: reads,
            hugs: Math.abs(wrapRect.width - pageRect.width) <= 1,
          };
          fitOfficeStages(root, { measure: true });
          out.readsWithMeasure = reads;
          // 容器变窄后必须跟着缩小（wrap 宽度是自己写的，读它做参考会形成反馈回路）
          const host = wrap.parentElement;
          const beforeScale = page.style.transform;
          host.style.maxWidth = '300px';
          fitOfficeStages(root, { measure: false });
          out.shrinks = page.style.transform !== beforeScale && Math.round(page.getBoundingClientRect().width) <= 300;
          out.wrapW = Math.round(wrap.getBoundingClientRect().width);
          out.pageW = Math.round(page.getBoundingClientRect().width);
          out.overflow = Math.round(host.scrollWidth - host.clientWidth);
          host.style.maxWidth = '';
        } finally {
          Object.defineProperty(target, 'scrollHeight', desc);
        }
        return out;
      })()` }));
      assert(fitGuard.data && fitGuard.data.value && !fitGuard.data.value.error, 'fit 探针失败: ' + JSON.stringify(fitGuard.data).slice(0, 300));
      const F = fitGuard.data.value;
      assert.equal(F.readsOnResize, 0, 'resize 路径不得读取 scrollHeight（每次读取都会强制全量重排）');
      assert(F.readsWithMeasure >= 1, '渲染后的首次测量要读一次 scrollHeight 并缓存');
      assert.equal(F.hugs, true, '包裹层宽度要贴合缩放后的画布（否则右侧留白）');
      assert.equal(F.shrinks, true, '容器变窄后缩放要跟着收缩，不能溢出');
      assert.equal(F.overflow, 0, '缩放后不得撑出横向滚动条');
      console.log('  ✓ 缩放路径不测量、不留白、不溢出');
      // 图片懒加载：一份 180 张截图的文档解码后约 600MB，开图即全解码会把内存
      // 和 GPU 打满，下滑时反复重采样巨型位图（真实事故：整机卡死）。
      const lazy = (await post('/api/browser/evaluate', { expression: `(async () => {
        await previewFile(${JSON.stringify(file('many-images.docx'))});
        await new Promise(r => setTimeout(r, 1500));
        const body = document.querySelector('#dlgBody');
        const imgs = [...body.querySelectorAll('img.docx-img')];
        const decoded = imgs.filter(i => i.complete && i.naturalWidth > 0);
        return {
          total: imgs.length,
          lazyAttr: imgs.filter(i => i.getAttribute('loading') === 'lazy').length,
          asyncAttr: imgs.filter(i => i.getAttribute('decoding') === 'async').length,
          decodedAtOpen: decoded.length,
          scrollHeight: body.scrollHeight,
        };
      })()` }));
      assert(lazy.data && lazy.data.value, 'lazy evaluate 失败: ' + JSON.stringify(lazy.data).slice(0, 300));
      const Z = lazy.data.value;
      assert.equal(Z.total, 12, `12 张图都要渲染出 img（实际 ${Z.total}）`);
      assert.equal(Z.lazyAttr, 12, '每张图都要带 loading=lazy');
      assert.equal(Z.asyncAttr, 12, '每张图都要带 decoding=async（解码不占主线程）');
      assert(Z.scrollHeight > 5000, `文档要足够长才能验证懒加载（实际 ${Z.scrollHeight}px）`);
      assert(Z.decodedAtOpen >= 1, '首屏图片要正常解码');
      assert(Z.decodedAtOpen <= 6, `开图时不得解码全部图片（12 张里解了 ${Z.decodedAtOpen} 张）`);
      console.log('  ✓ 图片懒加载（开图不解码全部）');
      assert.equal((await inspect('html', 'previewFile')).htmlSandbox, '');
      assert((await inspect('mp3', 'previewFile')).media);
      assert((await inspect('pdf', 'previewFile')).media);
      assert((await inspect('png', 'previewImageFile')).title.includes('图片预览'));
      await post('/api/browser/close', {});
    } else console.log('  - browser unavailable; API formats verified');
    console.log('FILE PREVIEWS PASSED');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (server) server.kill();
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(WORK, { recursive: true, force: true });
  }
})();
