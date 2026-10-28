// Structured Office generation, retaining the simple paragraph/row/slide input.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { record, fail } = require('./workflow-store');
const templates = {
  plain: { font: 'Arial', color: '243247', accent: '4263EB', size: 22 },
  report: { font: 'Arial', color: '17324D', accent: '167D8D', size: 22 },
  proposal: { font: 'Arial', color: '302547', accent: '7856B6', size: 24 },
};
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const resolve = (cwd, file) => { if (typeof file !== 'string' || !file.trim() || file.includes('\0')) fail('文件路径无效'); return path.isAbsolute(file) ? file : path.resolve(cwd, file); };
const bounded = (items, label, max) => { if (!Array.isArray(items) || items.length > max) fail(label + '必须是数组且不超过 ' + max + ' 项'); return items; };
function theme(args) { if (args.template && !templates[args.template]) fail('模板可选 plain/report/proposal'); return { ...templates[args.template || 'plain'], ...(record(args.theme) ? args.theme : {}) }; }
function image(cwd, file) { const full = resolve(cwd, file); if (!/\.(png|jpe?g|gif|bmp)$/i.test(full) || fs.statSync(full).size > 16 * 1024 * 1024) fail('Office 图片须为 PNG/JPEG/GIF/BMP 且不超过 16MB'); return full; }
async function writeAtomic(file, bytes) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true }); const tmp = path.join(path.dirname(file), '.agenthub-office-' + crypto.randomUUID() + '.tmp');
  try { await fs.promises.writeFile(tmp, bytes); await fs.promises.rename(tmp, file); } finally { await fs.promises.unlink(tmp).catch(() => {}); }
}
function output(file, type, detail = '') { return { output: '已生成 ' + type + '：' + file + detail, files: [{ path: file, tool: 'Write', snapshotUnavailable: true }] }; }
async function makeDocx(args, cwd) {
  const d = require('docx'), t = theme(args), file = resolve(cwd, args.path);
  if (!/\.docx$/i.test(file)) fail('Word 路径须以 .docx 结尾');
  const blocks = args.blocks ?? args.paragraphs ?? [];
  bounded(blocks, args.blocks != null ? 'blocks ' : 'paragraphs ', 1000); if (!args.title && !blocks.length) fail('paragraphs 不能为空');
  const paragraph = b => new d.Paragraph({
    children: Array.isArray(b.runs) ? b.runs.map(r => new d.TextRun({ text: String(r.text || ''), bold: !!r.bold, italics: !!r.italic, color: r.color, size: r.size })) : [new d.TextRun({ text: String(b.text || ''), bold: !!b.bold, italics: !!b.italic })],
    heading: b.heading ? d.HeadingLevel['HEADING_' + Math.min(6, Math.max(1, Number(b.heading)))] : undefined,
    bullet: b.bullet ? { level: 0 } : undefined, alignment: ({ center: d.AlignmentType.CENTER, right: d.AlignmentType.RIGHT })[b.align], spacing: { after: 140 },
  });
  const children = args.title ? [paragraph({ text: args.title, heading: 1 })] : [];
  for (const b of blocks) {
    if (!record(b)) fail('Word 正文项无效');
    if (b.type === 'table') {
      bounded(b.rows, '表格行', 500);
      children.push(new d.Table({ width: { size: 100, type: d.WidthType.PERCENTAGE }, rows: b.rows.map((row, ri) => new d.TableRow({ tableHeader: ri === 0 && b.header !== false, children: bounded(row, '表格列', 40).map(c => new d.TableCell({ shading: ri === 0 && b.header !== false ? { fill: t.accent } : undefined, children: [paragraph(record(c) ? c : { text: String(c ?? ''), bold: ri === 0 })] })) })) }));
    } else if (b.type === 'image') {
      const full = image(cwd, b.path), ext = path.extname(full).slice(1).toLowerCase();
      children.push(new d.Paragraph({ children: [new d.ImageRun({ data: fs.readFileSync(full), type: ext === 'jpg' ? 'jpeg' : ext, transformation: { width: Number(b.width) || 480, height: Number(b.height) || 270 } })] }));
      if (b.caption) children.push(paragraph({ text: b.caption, italic: true, align: 'center' }));
    } else if (b.type === 'pageBreak') children.push(new d.Paragraph({ children: [new d.PageBreak()] }));
    else children.push(paragraph(b));
  }
  const properties = { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100, ...(args.margins || {}) } } };
  const doc = new d.Document({ styles: { default: { document: { run: { font: t.font, size: t.size, color: t.color } } } }, sections: [{ properties, headers: args.header ? { default: new d.Header({ children: [paragraph({ text: args.header })] }) } : undefined, footers: args.footer ? { default: new d.Footer({ children: [paragraph({ text: args.footer })] }) } : undefined, children }] });
  await writeAtomic(file, await d.Packer.toBuffer(doc)); return output(file, 'Word');
}
function position(element, fallback) {
  const out = {}; for (const k of ['x', 'y', 'w', 'h']) { out[k] = element[k] ?? fallback[k]; if (!Number.isFinite(out[k]) || out[k] < 0 || out[k] > 30) fail('幻灯片元素位置无效'); } return out;
}
async function makePptx(args, cwd) {
  const Pptx = require('pptxgenjs'), p = new Pptx(), t = theme(args), file = resolve(cwd, args.path);
  if (!/\.pptx$/i.test(file)) fail('PPT 路径须以 .pptx 结尾');
  const slides = bounded(args.slides || [], '幻灯片', 200); if (!args.title && !slides.length) fail('slides 不能为空');
  p.layout = args.layout || 'LAYOUT_WIDE'; p.title = args.title || ''; p.theme = { headFontFace: t.font, bodyFontFace: t.font, lang: 'zh-CN' };
  for (const slide of slides) {
    const s = p.addSlide(); if (slide.background) s.background = { color: slide.background };
    if (slide.title) s.addText(String(slide.title), { x: .6, y: .4, w: 12, h: .7, fontSize: 26, bold: true, color: t.color });
    if (slide.bullets?.length) s.addText(slide.bullets.map(b => ({ text: String(b), options: { bullet: true, breakLine: true } })), { x: .8, y: 1.4, w: 11.8, h: 5, fontSize: 18, color: t.color });
    else if (slide.text) s.addText(String(slide.text), { x: .8, y: 1.4, w: 11.8, h: 5, fontSize: 18, color: t.color });
    for (const e of bounded(slide.elements || [], '页面元素', 100)) {
      const box = position(e, { x: .8, y: 1.4, w: 11.8, h: 5 });
      if (e.type === 'image') s.addImage({ path: image(cwd, e.path), ...box });
      else if (e.type === 'table') s.addTable(bounded(e.rows, '表格行', 100), { ...box, fontSize: e.fontSize || 14, color: t.color, border: { pt: 1, color: 'D8DDE5' } });
      else if (e.type === 'chart') {
        const type = e.chartType || 'bar'; if (!['bar', 'line', 'pie', 'doughnut', 'area', 'scatter'].includes(type)) fail('不支持的 PPT 图表类型');
        s.addChart(p.ChartType[type], bounded(e.series, '图表系列', 20), { ...box, showLegend: true, showTitle: !!e.title, title: e.title || '', chartColors: [t.accent, '70A7B8', 'DFB165'], showValue: !!e.showValue });
      } else if (e.type === 'shape') { if (!['rect', 'ellipse', 'line', 'roundRect'].includes(e.shape || 'rect')) fail('形状无效'); s.addShape(p.ShapeType[e.shape || 'rect'], { ...box, fill: { color: e.color || t.accent }, line: { color: e.color || t.accent } }); }
      else if (e.type === 'text') s.addText(String(e.text || ''), { ...box, fontSize: e.fontSize || 18, bold: !!e.bold, color: e.color || t.color });
      else fail('未知幻灯片元素类型');
    }
    if (slide.notes) s.addNotes(String(slide.notes));
  }
  await writeAtomic(file, Buffer.from(await p.write({ outputType: 'nodebuffer' }))); return output(file, 'PPT', '（' + slides.length + ' 页）');
}
function formulaRef(sheet, ref) { if (!/^\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?$/.test(ref || '')) fail('图表引用须为单元格或区域'); return "'" + sheet.replace(/'/g, "''") + "'!" + ref; }
function chartXml(sheet, chart) {
  const type = chart.type || 'bar'; if (!['bar', 'line', 'pie', 'area'].includes(type)) fail('Excel 图表可选 bar/line/pie/area');
  const tag = type + 'Chart'; const series = bounded(chart.series, '图表系列', 20).map((s, i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${esc(s.name || 'Series ' + (i + 1))}</c:v></c:tx><c:cat><c:strRef><c:f>${esc(formulaRef(sheet, s.categories))}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${esc(formulaRef(sheet, s.values))}</c:f></c:numRef></c:val></c:ser>`).join('');
  const axes = type === 'pie' ? '' : '<c:axId val="100"/><c:axId val="200"/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/><c:${tag}>${type === 'bar' ? '<c:barDir val="col"/><c:grouping val="clustered"/>' : type !== 'pie' ? '<c:grouping val="standard"/>' : ''}${series}${axes}</c:${tag}>${type === 'pie' ? '' : '<c:catAx><c:axId val="100"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="200"/><c:crosses val="autoZero"/></c:catAx><c:valAx><c:axId val="200"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:crossAx val="100"/><c:crosses val="autoZero"/></c:valAx>'}</c:plotArea><c:legend><c:legendPos val="r"/></c:legend><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`;
}
async function addCharts(bytes, sheets) {
  const zip = await require('jszip').loadAsync(bytes); let index = 0, types = await zip.file('[Content_Types].xml').async('string');
  for (const [si, sheet] of sheets.entries()) {
    if (!sheet.charts?.length) continue;
    let sx = await zip.file(`xl/worksheets/sheet${si + 1}.xml`).async('string');
    const relFile = `xl/worksheets/_rels/sheet${si + 1}.xml.rels`;
    let rel = zip.file(relFile) ? await zip.file(relFile).async('string') : '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    const existing = /<Relationship\b[^>]*Type="[^"]*\/drawing"[^>]*Target="([^"]+)"/.exec(rel);
    const drawingPath = existing ? path.posix.normalize('xl/worksheets/' + existing[1]) : `xl/drawings/agenthub${si + 1}.xml`;
    const drawingName = path.posix.basename(drawingPath), drawingRels = 'xl/drawings/_rels/' + drawingName + '.rels';
    let drawing = zip.file(drawingPath) ? await zip.file(drawingPath).async('string') : '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"></xdr:wsDr>';
    let dr = zip.file(drawingRels) ? await zip.file(drawingRels).async('string') : '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    if (!existing) { const rid = 'rIdAgentHubChart'; rel = rel.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/${drawingName}"/></Relationships>`); sx = sx.replace('</worksheet>', `<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${rid}"/></worksheet>`); types = types.replace('</Types>', `<Override PartName="/${drawingPath}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`); }
    for (const chart of bounded(sheet.charts, 'Excel 图表', 20)) {
      const ci = ++index, rid = 'rIdAgentHub' + ci, col = Number(chart.col ?? 0), row = Number(chart.row ?? 5);
      if (!Number.isInteger(col) || col < 0 || col > 16380 || !Number.isInteger(row) || row < 0 || row > 1048550) fail('图表位置无效');
      const id = 1000 + ci;
      const anchor = `<xdr:twoCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${col + 8}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 15}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="${esc(chart.title || 'Chart ' + ci)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
      drawing = drawing.replace('</xdr:wsDr>', anchor + '</xdr:wsDr>'); dr = dr.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/agenthub${ci}.xml"/></Relationships>`);
      zip.file(`xl/charts/agenthub${ci}.xml`, chartXml(sheet.name || 'Sheet' + (si + 1), chart)); types = types.replace('</Types>', `<Override PartName="/xl/charts/agenthub${ci}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
    }
    zip.file(drawingPath, drawing); zip.file(drawingRels, dr); zip.file(relFile, rel); zip.file(`xl/worksheets/sheet${si + 1}.xml`, sx);
  }
  zip.file('[Content_Types].xml', types); return zip.generateAsync({ type: 'nodebuffer' });
}
async function makeXlsx(args, cwd) {
  const Excel = require('exceljs'), wb = new Excel.Workbook(), t = theme(args), file = resolve(cwd, args.path), sheets = bounded(args.sheets || [], '工作表', 100);
  if (!/\.xlsx$/i.test(file) || !sheets.length) fail('sheets 不能为空，路径须以 .xlsx 结尾');
  wb.calcProperties.fullCalcOnLoad = true;
  for (const [si, sh] of sheets.entries()) {
    const name = String(sh.name || 'Sheet' + (si + 1)); if (name.length > 31 || /[\\/*?:\[\]]/.test(name)) fail('工作表名称无效');
    const ws = wb.addWorksheet(name);
    for (const row of bounded(sh.rows || [], '行', 50000)) ws.addRow(bounded(row, '列', 200).map(c => {
      if (!record(c)) return c;
      if (c.formula != null) { if (typeof c.formula !== 'string' || c.formula.length > 8192) fail('公式无效'); return { formula: c.formula.replace(/^=/, ''), ...(c.result != null ? { result: c.result } : {}) }; }
      return c.value ?? JSON.stringify(c);
    }));
    if (sh.columns) for (const [ci, c] of bounded(sh.columns, '列设置', 200).entries()) { const col = ws.getColumn(ci + 1); col.width = Number(c.width) || 18; if (c.numFmt) { col.numFmt = c.numFmt; col.eachCell(cell => { cell.numFmt = c.numFmt; }); } }
    for (const cell of bounded(sh.cells || [], '单元格格式', 10000)) { if (!/^[A-Z]{1,3}\d+$/.test(cell.address || '')) fail('单元格地址无效'); const c = ws.getCell(cell.address); if (cell.value !== undefined) c.value = cell.value; if (cell.numFmt) c.numFmt = cell.numFmt; if (cell.bold != null || cell.color) c.font = { name: t.font, bold: !!cell.bold, ...(cell.color ? { color: { argb: cell.color } } : {}) }; if (cell.fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cell.fill } }; }
    if (args.template === 'report' || sh.header) { ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + t.accent } }; }
    if (sh.freezeRows) ws.views = [{ state: 'frozen', ySplit: Math.min(100, Number(sh.freezeRows)), xSplit: 0 }];
    if (sh.autoFilter) ws.autoFilter = sh.autoFilter;
    for (const merge of bounded(sh.merges || [], '合并区域', 100)) ws.mergeCells(merge);
    for (const table of bounded(sh.tables || [], 'Excel 表格', 20)) ws.addTable(table);
    for (const img of bounded(sh.images || [], 'Excel 图片', 20)) { const full = image(cwd, img.path), ext = path.extname(full).slice(1).toLowerCase(); const id = wb.addImage({ filename: full, extension: ext === 'jpg' ? 'jpeg' : ext }); ws.addImage(id, img.range || 'A5:D15'); }
  }
  let bytes = Buffer.from(await wb.xlsx.writeBuffer()); if (sheets.some(s => s.charts?.length)) bytes = await addCharts(bytes, sheets);
  await writeAtomic(file, bytes); return output(file, 'Excel', '（' + sheets.length + ' 个工作表）');
}
const array = items => ({ type: 'array', items });
const object = properties => ({ type: 'object', properties });
const str = { type: 'string' }, num = { type: 'number' };
const rows = array(array({}));
const common = { template: { type: 'string', enum: Object.keys(templates) }, theme: object({ font: str, color: str, accent: str, size: num }) };
const schemas = {
  make_docx: { ...common, header: str, footer: str, margins: object({ top: num, bottom: num, left: num, right: num }), blocks: array(object({ type: { type: 'string', enum: ['paragraph', 'table', 'image', 'pageBreak'] }, text: str, heading: num, bullet: { type: 'boolean' }, bold: { type: 'boolean' }, italic: { type: 'boolean' }, align: str, rows, path: str, width: num, height: num, caption: str, runs: array(object({ text: str, bold: { type: 'boolean' }, italic: { type: 'boolean' }, color: str, size: num })) })) },
  make_pptx: { ...common, layout: str, slides: array(object({ title: str, text: str, bullets: array(str), notes: str, background: str, elements: array(object({ type: { type: 'string', enum: ['text', 'image', 'table', 'chart', 'shape'] }, x: num, y: num, w: num, h: num, text: str, path: str, rows, chartType: str, series: array(object({ name: str, labels: array(str), values: array(num) })), shape: str, color: str, fontSize: num })) })) },
  make_xlsx: { ...common, sheets: array(object({ name: str, rows, header: { type: 'boolean' }, columns: array(object({ width: num, numFmt: str })), cells: array(object({ address: str, value: {}, numFmt: str, bold: { type: 'boolean' }, color: str, fill: str })), merges: array(str), freezeRows: num, autoFilter: str, images: array(object({ path: str, range: str })), tables: array({ type: 'object' }), charts: array(object({ type: str, title: str, col: num, row: num, series: array(object({ name: str, categories: str, values: str })) })) })) },
};
module.exports = { makeDocx, makePptx, makeXlsx, schemas, templates };
