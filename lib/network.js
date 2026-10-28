'use strict';
const { execFileSync } = require('node:child_process');
function proxyUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try { const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw); return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.search && !url.hash ? url.href.replace(/\/$/, '') : ''; } catch { return ''; }
}
function systemProxy(text) {
  if (!/^\s*ProxyEnable\s+REG_DWORD\s+0x0*1\s*$/im.test(text || '')) return null;
  const raw = /^\s*ProxyServer\s+REG_SZ\s+(.+)$/im.exec(text || '')?.[1]?.trim();
  if (!raw) return null;
  const protocols = Object.fromEntries(raw.split(';').map(s => /^\s*(http|https)\s*=\s*(.+)$/i.exec(s)).filter(Boolean).map(m => [m[1].toLowerCase(), proxyUrl(m[2])]));
  const shared = raw.includes('=') ? '' : proxyUrl(raw);
  const httpProxy = protocols.http || shared, httpsProxy = protocols.https || shared || httpProxy;
  if (!httpProxy && !httpsProxy) return null;
  const bypass = /^\s*ProxyOverride\s+REG_SZ\s+(.+)$/im.exec(text || '')?.[1]?.trim() || '';
  return { httpProxy, httpsProxy, bypass: bypass.split(';').filter(s => s && s !== '<local>').join(',') };
}
function options(env, windowsSettings = '') {
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY ?? env.all_proxy ?? env.ALL_PROXY;
  const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY ?? env.all_proxy ?? env.ALL_PROXY;
  const explicit = !!(httpProxy || httpsProxy), system = explicit ? null : systemProxy(windowsSettings);
  return { source: explicit ? 'environment' : system ? 'windows' : 'direct',
    httpProxy: explicit ? String(httpProxy || '') : system?.httpProxy || '',
    httpsProxy: explicit ? String(httpsProxy || httpProxy || '') : system?.httpsProxy || '',
    noProxy: [env.no_proxy ?? env.NO_PROXY ?? system?.bypass ?? '', 'localhost', '127.0.0.1', '[::1]', '::1'].filter(Boolean).join(','),
  };
}
function installProxy({ env = process.env, platform = process.platform, registry } = {}) {
  let windowsSettings = registry || '';
  if (platform === 'win32' && registry === undefined && !env.http_proxy && !env.HTTP_PROXY && !env.https_proxy && !env.HTTPS_PROXY && !env.all_proxy && !env.ALL_PROXY) {
    try { windowsSettings = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { windowsHide: true, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch {}
  }
  const config = options(env, windowsSettings), { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici');
  const dispatcher = new EnvHttpProxyAgent({ httpProxy: config.httpProxy, httpsProxy: config.httpsProxy, noProxy: config.noProxy });
  setGlobalDispatcher(dispatcher);
  return { source: config.source, dispatcher };
}
module.exports = { proxyUrl, systemProxy, options, installProxy };
