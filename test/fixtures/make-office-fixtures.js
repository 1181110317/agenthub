// 生成带图片/格式的 Office 夹具，供预览解析（docx/pptx/xlsx → HTML）验收使用。
// 单独放一个脚本，是因为前端预览的输入必须是「真实库产出的压缩包」，
// 手写 XML 会漏掉 r:embed、a:off/a:ext 这些实际排版字段。
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType, BorderStyle,
} = require('docx');
const PptxGenJS = require('pptxgenjs');
const ExcelJS = require('exceljs');

const OUT = __dirname;
// 1×1 PNG；用可见的纯色方块，断言时按字节比对即可确认「图确实被内联出来了」。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

async function makeDocx() {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: 'DOCX_HEADING_OK', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: 'DOCX_CENTER_OK', color: 'FF0000', size: 32 })],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'DOCX_BOLD_OK', bold: true }),
            new TextRun({ text: ' / ' }),
            new TextRun({ text: 'DOCX_ITALIC_OK', italics: true }),
            new TextRun({ text: ' / ' }),
            new TextRun({ text: 'DOCX_UNDERLINE_OK', underline: {} }),
          ],
        }),
        new Paragraph({
          children: [new ImageRun({ data: PNG, transformation: { width: 120, height: 90 }, type: 'png' })],
        }),
        new Table({
          width: { size: 6000, type: WidthType.DXA },
          rows: [
            new TableRow({
              children: [
                new TableCell({ children: [new Paragraph('DOCX_H1_OK')] }),
                new TableCell({ children: [new Paragraph('DOCX_H2_OK')] }),
              ],
            }),
            new TableRow({
              children: [
                new TableCell({ children: [new Paragraph('DOCX_C1_OK')] }),
                new TableCell({ children: [new Paragraph('DOCX_C2_OK')] }),
              ],
            }),
          ],
        }),
        new Paragraph({ text: 'DOCX_AFTER_ONLY_ONE', pageBreakBefore: true }),
      ],
    }],
  });
  fs.writeFileSync(path.join(OUT, 'sample-images.docx'), await Packer.toBuffer(doc));
}

async function makePptx() {
  const pptx = new PptxGenJS();
  const slide = pptx.addSlide();
  slide.background = { color: '1F2937' };
  slide.addText('PPTX_TITLE_OK', { x: 0.5, y: 0.4, w: 8, h: 0.8, fontSize: 28, bold: true, color: 'FFFFFF' });
  slide.addText([{ text: 'PPTX_BULLET_OK', options: { bullet: true } }], { x: 0.5, y: 1.4, w: 4, h: 1.6, fontSize: 16, color: 'E5E7EB' });
  slide.addImage({ data: 'image/png;base64,' + PNG.toString('base64'), x: 5.2, y: 1.4, w: 2, h: 2 });
  const second = pptx.addSlide();
  second.addText('PPTX_SECOND_OK', { x: 0.5, y: 2, w: 6, h: 1, fontSize: 20 });
  await pptx.writeFile({ fileName: path.join(OUT, 'sample-images.pptx') });
}

async function makeXlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('数据表');
  ws.getColumn(1).width = 18;
  ws.getColumn(2).width = 14;
  ws.addRow(['XLSX_HEAD_OK', 'XLSX_DATE_OK']).font = { bold: true };
  ws.addRow(['XLSX_ROW_OK', new Date(2026, 2, 15)]);
  ws.getCell('B2').numFmt = 'yyyy-mm-dd';
  // 合并单元格：预览要给出 colspan，而不是把合并区域摊成重复空格
  ws.mergeCells('A3:B3');
  ws.getCell('A3').value = 'XLSX_MERGE_OK';
  ws.getCell('A3').alignment = { horizontal: 'center' };
  const second = wb.addWorksheet('第二表');
  second.addRow(['SECOND_SHEET_OK']);
  await wb.xlsx.writeFile(path.join(OUT, 'sample-images.xlsx'));
}

(async () => {
  await makeDocx();
  await makePptx();
  await makeXlsx();
  console.log('fixtures written to ' + OUT);
})();
