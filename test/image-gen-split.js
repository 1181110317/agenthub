'use strict';
// 真实验证 v2：聊天走本地 mock（有聊天模型），图像走真实 synapai 端点（独立配置）。
// 验证 imageBaseUrl/imageApiKey 分端点生效。
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KEY = process.env.AGENTHUB_IMG_KEY || '';
if (!KEY) { console.error('需要 AGENTHUB_IMG_KEY'); process.exit(1); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-img3-'));
process.env.AGENTHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-img3d-')).toString();

let chatRound = 0;
const mock = http.createServer((rq, rs) => {
  let body = '';
  rq.on('data', c => body += c);
  rq.on('end', () => {
    if (rq.url.includes('/images/generations')) return rs.writeHead(500).end('{"error":"chat-mock-has-no-images"}'); // 图像绝不该打到聊天端点
    chatRound++;
    rs.writeHead(200, { 'content-type': 'text/event-stream' });
    if (chatRound === 1) {
      rs.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'image_generate', arguments: JSON.stringify({ prompt: 'a blue square', path: 'blue.png', size: '512x512' }) } }] } }] }) + '\n\n');
    } else {
      rs.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '图好了' } }] }) + '\n\n');
    }
    rs.write('data: ' + JSON.stringify({ choices: [{}], usage: { prompt_tokens: 5, completion_tokens: 3 } }) + '\n\n');
    rs.write('data: [DONE]\n\n');
    rs.end();
  });
});

mock.listen(23173, '127.0.0.1', async () => {
  const apiAgent = require(path.join(ROOT, 'lib', 'api-agent.js'));
  const evs = [];
  const handle = apiAgent.runApiAgent({
    prompt: '生成一张蓝色方块图',
    model: 'mock-chat',
    provider: {
      id: 'p1', agent: 'builtin', protocol: 'openai',
      baseUrl: 'http://127.0.0.1:23173', apiKey: 'mock-chat-key',
      imageModel: 'gpt-image-2',
      imageBaseUrl: 'https://api.synapai.top/v1', imageApiKey: KEY,
      models: ['mock-chat'],
    },
    history: [], cwd: TMP, autoPerms: true,
  }, ev => evs.push(ev));
  const code = await handle.done;
  const file = path.join(TMP, 'blue.png');
  let size = 0;
  try { size = fs.statSync(file).size; } catch {}
  const chatMockUntouched = true; // mock 图像路径返回 500——若工具误打聊天端点会失败
  console.log('退出码:', code, '| 文件:', size + ' bytes');
  const pass = code === 0 && size > 1000;
  console.log(pass ? '✅ 分端点画图验证通过（聊天=本地mock，图像=真实 synapai）' : '❌ 失败 ' + JSON.stringify(evs.map(e => e.kind + ':' + String(e.text || e.output || e.name || '').slice(0, 100))));
  mock.close();
  process.exit(pass ? 0 : 1);
});
