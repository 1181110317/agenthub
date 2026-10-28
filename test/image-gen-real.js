'use strict';
// 真实图像生成验证（v2）：本地 mock 聊天端点（指示模型调用 image_generate 工具）
// + 图像请求转发到真实端点。验证完整工具链：execTool 分发 → tGenerateImage →
// 真实 HTTP 生成 → b64 解码 → 落盘 → tooloutput → 终答。
// 用法：AGENTHUB_IMG_KEY=... node test/image-gen-real.js
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KEY = process.env.AGENTHUB_IMG_KEY || '';
const IMG_BASE = 'https://api.synapai.top/v1';
const IMG_MODEL = 'gpt-image-2';
if (!KEY) { console.error('需要 AGENTHUB_IMG_KEY'); process.exit(1); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-img2-'));
process.env.AGENTHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-img2d-')).toString();

// 本地双角色端点：/chat/completions 演模型（第一轮回工具调用，第二轮回终答）；
// /images/generations 反代真实端点。
let chatRound = 0;
const mock = http.createServer((rq, rs) => {
  let body = '';
  rq.on('data', c => body += c);
  rq.on('end', () => {
    if (rq.url.includes('/images/generations')) {
      const up = https.request(IMG_BASE + '/images/generations', {
        method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + KEY },
      }, ur => {
        rs.writeHead(ur.statusCode, { 'content-type': ur.headers['content-type'] || 'application/json' });
        ur.pipe(rs);
      });
      up.on('error', () => { rs.writeHead(502); rs.end('{}'); });
      up.end(body);
      return;
    }
    // chat：第一轮回 tool_call，第二轮回终答
    chatRound++;
    rs.writeHead(200, { 'content-type': 'text/event-stream' });
    if (chatRound === 1) {
      rs.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'image_generate', arguments: JSON.stringify({ prompt: 'a solid red circle on white background', path: 'red-circle.png', size: '512x512' }) } }] } }] }) + '\n\n');
    } else {
      rs.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '图片已生成并保存。' } }] }) + '\n\n');
    }
    rs.write('data: ' + JSON.stringify({ choices: [{}], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + '\n\n');
    rs.write('data: [DONE]\n\n');
    rs.end();
  });
});

mock.listen(23172, '127.0.0.1', async () => {
  const apiAgent = require(path.join(ROOT, 'lib', 'api-agent.js'));
  const evs = [];
  const started = Date.now();
  const handle = apiAgent.runApiAgent({
    prompt: '生成一张红色圆形图',
    model: 'mock-chat',
    provider: { id: 'p1', agent: 'builtin', protocol: 'openai', baseUrl: 'http://127.0.0.1:23172', apiKey: 'mock', imageModel: IMG_MODEL, models: ['mock-chat'] },
    history: [], cwd: TMP, autoPerms: true,
  }, ev => evs.push(ev));
  const code = await handle.done;
  const file = path.join(TMP, 'red-circle.png');
  let size = 0, head = null;
  try { const b = fs.readFileSync(file); size = b.length; head = [b[0], b[1]]; } catch {}
  const toolOk = evs.some(e => e.kind === 'tool' && e.name === 'image_generate');
  const textOk = evs.some(e => e.kind === 'text' && /已生成图片/.test(e.text || ''));
  console.log('回合退出码:', code, '| 耗时', Math.round((Date.now() - started) / 1000) + 's');
  console.log('工具被调用:', toolOk, '| 工具结果事件:', textOk);
  console.log('文件:', file, size + ' bytes', head ? 'PNG头=' + head : '');
  const pass = code === 0 && toolOk && size > 1000 && head && head[0] === 0x89;
  console.log(pass ? '✅ 真实端点 image_generate 全链路验证通过' : '❌ 失败');
  if (!pass) console.log(JSON.stringify(evs.map(e => e.kind + ':' + String(e.text || e.output || e.name || '').slice(0, 160)), null, 1));
  mock.close();
  process.exit(pass ? 0 : 1);
});
