// Codex OAuth 额度：解析 5 小时 / 7 天窗口、大小写字段与鉴权头。
const assert = require('assert');
const http = require('http');
const balance = require('../lib/balance');

const fake = http.createServer((req, res) => {
  assert.equal(req.headers.authorization, 'Bearer oauth-test');
  assert.equal(req.headers['chatgpt-account-id'], 'acct-test');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 38, limit_window_seconds: 18000, reset_at: 1900000000 },
      secondary_window: { used_percent: 78, limit_window_seconds: 604800, reset_at: 1900600000 },
    },
  }));
});

(async () => {
  try {
    await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
    process.env.AGENTHUB_CODEX_USAGE_URL = `http://127.0.0.1:${fake.address().port}/usage`;
    const result = await balance.checkBalance({
      agent: 'codex', baseUrl: '', apiKey: '',
      raw: { auth: { auth_mode: 'chatgpt', tokens: { access_token: 'oauth-test', account_id: 'acct-test' } } },
    });
    assert.equal(result.supported, true);
    assert.equal(result.kind, 'codex-usage');
    assert.deepEqual(result.windows.map(w => [w.label, w.usedPercent, w.remainingPercent]), [
      ['5 小时', 38, 62], ['7 天', 78, 22],
    ]);
    assert.equal(balance.canCheck({ agent: 'codex', baseUrl: '', apiKey: '', raw: { auth: { tokens: { access_token: 'x' } } } }), true);
    console.log('balance-codex: ok');
  } finally {
    delete process.env.AGENTHUB_CODEX_USAGE_URL;
    await new Promise(resolve => fake.close(resolve));
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
