// Built-in agent: model tool calls produce real, readable Office files.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');
const { runApiAgent } = require('../lib/api-agent');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-office-generation-'));
const tools = [
  { name: 'make_docx', arguments: { path: 'audit.docx', title: 'Word 验收', paragraphs: [{ text: 'WORD_OK' }] } },
  { name: 'make_pptx', arguments: { path: 'audit.pptx', title: 'PPT 验收', slides: [{ title: 'PPT_OK', bullets: ['第一项'] }] } },
  { name: 'make_xlsx', arguments: { path: 'audit.xlsx', sheets: [{ name: 'Sheet1', rows: [['name', 'value'], ['EXCEL_OK', 42]] }] } },
];
let requests = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', part => { body += part; });
  req.on('end', () => {
    const payload = JSON.parse(body);
    requests++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = delta => res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
    if (requests === 1) {
      assert(tools.every(tool => payload.tools.some(t => t.function.name === tool.name)), 'Office tools not advertised');
      for (const [index, tool] of tools.entries()) frame({ tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] });
    } else {
      assert.equal(payload.messages.filter(m => m.role === 'tool').length, 3);
      frame({ content: '文件已生成' });
    }
    res.end();
  });
});

(async () => {
  try {
    await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
    const events = [];
    const handle = runApiAgent({
      prompt: '生成 Word、PPT、Excel', cwd: work, model: 'audit-model', autoPerms: true, history: [],
      provider: { agent: 'codex', name: 'local-audit', apiKey: 'fixture-key', baseUrl: `http://127.0.0.1:${fake.address().port}/v1` },
    }, event => events.push(event));
    assert.equal(await handle.done, 0);
    assert.equal(requests, 2);
    assert.equal(events.filter(e => e.kind === 'files').length, 3);
    const doc = await JSZip.loadAsync(fs.readFileSync(path.join(work, 'audit.docx')));
    assert((await doc.file('word/document.xml').async('string')).includes('WORD_OK'));
    const ppt = await JSZip.loadAsync(fs.readFileSync(path.join(work, 'audit.pptx')));
    assert((await ppt.file('ppt/slides/slide1.xml').async('string')).includes('PPT_OK'));
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(path.join(work, 'audit.xlsx'));
    assert.equal(book.getWorksheet('Sheet1').getCell('A2').value, 'EXCEL_OK');
    assert.equal(book.getWorksheet('Sheet1').getCell('B2').value, 42);
    console.log('[office-generation] built-in agent Word/PPT/Excel files passed');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    await new Promise(resolve => fake.close(resolve));
    fs.rmSync(work, { recursive: true, force: true });
  }
})();
