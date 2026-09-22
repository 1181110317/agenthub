// 默认工作区：会话没有指定工作目录时，Agent / 终端实际落脚的地方。
//
// 这里绝不能用 process.cwd()。它是 AgentHub 自己的安装目录（用
// `node server.js` 或 _run-server.bat 启动时就是仓库根），拿它当用户工作目录
// 会让 Agent 生成的文件、终端里的操作全部堆在代码仓库里，越用越乱。
// 默认改到用户主目录下的固定文件夹，可用 AGENTHUB_WORKSPACE 覆盖。
const fs = require('fs');
const os = require('os');
const path = require('path');

let cached = '';

function defaultWorkspaceDir() {
  if (cached) return cached;
  const override = String(process.env.AGENTHUB_WORKSPACE || '').trim();
  const dir = override && path.isAbsolute(override) ? override : path.join(os.homedir(), 'AgentHub');
  // 目录不存在就地创建：调用方拿到的必须是一个可用路径，
  // 否则 spawn 会直接失败在工作目录上。创建失败仍返回该路径，
  // 由 requireLocalDirectory 的统一校验给出明确报错。
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  cached = dir;
  return dir;
}

// 本机工作目录的唯一判定入口：空值一律回落到默认工作区，
// 传了路径就必须真实存在且是目录——宁可明确报错，也不要静默跑到别的目录里。
// 三个 Agent 桥（claude / codex / zcode）与内置 Agent 共用这一份实现。
function requireLocalDirectory(cwd) {
  if (!cwd) return defaultWorkspaceDir();
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error('不是文件夹');
  } catch {
    throw new Error('工作目录不存在或无法访问：' + cwd);
  }
  return cwd;
}

module.exports = { defaultWorkspaceDir, requireLocalDirectory };
