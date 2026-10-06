#!/usr/bin/env node
/**
 * blogctl —— 博客本地预览「一键启动 / 关闭」命令行工具
 * ---------------------------------------------------------------------------
 * 平台：Windows 10/11 · macOS · Linux（同一份实现，只用 Node 内置模块）
 * 依赖：Node.js >= 22（博客本身也要求 22+）；装依赖时才需要 npm
 *
 * 用法（在博客仓库根目录）：
 *   Windows (cmd)        blogctl start            或  .\blogctl.cmd start
 *   Windows (PowerShell) .\blogctl start          或  .\blogctl.cmd start
 *   macOS / Linux        ./blogctl start          或  bash blogctl start
 *   （任何平台都能用）    node blogctl.mjs start
 *
 * 命令：
 *   start  [--port 4321] [--host 127.0.0.1] [--open] [--foreground] [--no-install]
 *        后台启动 astro dev，写入 .blogctl/server.json，并等页面可访问后打印地址。
 *        node_modules 不存在时自动执行 npm ci 安装依赖。
 *   stop          按记录的 PID 关闭（含子进程树），并清理状态文件。
 *   restart       等于 stop + start。
 *   status        查看是否在运行、PID、端口、URL、HTTP 探测结果。
 *   logs [-n 40] [-f]   查看 dev 日志（-f 持续跟踪，Ctrl+C 退出）。
 *   open          在默认浏览器打开本地站点。
 *   install       安装/重装依赖（npm ci，无 lockfile 时 npm install）。
 *   build         前台执行 astro build（产出 dist/）。
 *   check         前台执行 astro check（类型/诊断检查）。
 *   doctor        环境自检：Node 版本、npm、依赖、端口、状态文件。
 *
 * 说明：
 *   - 端口默认取 astro.config.mjs 的约定（4321），站点 base 也从配置里读（当前 /blog/）。
 *   - 若默认端口被占用且没有用 --port 指定，会自动顺延到下一个空闲端口。
 *   - 状态与日志都在 .blogctl/（已在 .gitignore 中忽略）。
 * ---------------------------------------------------------------------------
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(ROOT, '.blogctl');
const STATE_FILE = path.join(STATE_DIR, 'server.json');
const LOG_FILE = path.join(STATE_DIR, 'dev.log');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const DEFAULT_PORT = 4321;
const DEFAULT_HOST = '127.0.0.1';
const MIN_NODE_MAJOR = 22;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const ok = (s) => console.log(`${c(32, '✔')} ${s}`);
const warn = (s) => console.log(`${c(33, '!')} ${s}`);
const bad = (s) => console.log(`${c(31, '✘')} ${s}`);
const info = (s) => console.log(`  ${s}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- CLI 解析
const opts = {
  port: null,
  host: DEFAULT_HOST,
  open: false,
  foreground: false,
  install: true,
  follow: false,
  lines: 40,
};
const positional = [];

(function parseArgv() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    if (a === '--port' || a === '-p') opts.port = Number(take());
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
    else if (a === '--host') opts.host = take();
    else if (a.startsWith('--host=')) opts.host = a.slice(7);
    else if (a === '--open' || a === '-o') opts.open = true;
    else if (a === '--foreground' || a === '--fg') opts.foreground = true;
    else if (a === '--no-install') opts.install = false;
    else if (a === '--follow' || a === '-f') opts.follow = true;
    else if (a === '-n' || a === '--lines') opts.lines = Number(take());
    else if (a === '-h' || a === '--help') positional.push('help');
    else if (a === '-v' || a === '--version') positional.push('version');
    else if (a.startsWith('-')) bad(`未知参数：${a}（用 blogctl help 看用法）`);
    else positional.push(a.toLowerCase());
  }
})();

const command = positional[0] || 'start';
const rest = positional.slice(1);

// ---------------------------------------------------------------- 小工具
function readPkg() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** 从 astro.config.mjs 里读 base（站点子路径）与 dev 端口约定。 */
function readAstroConfig() {
  const out = { base: '/', site: null };
  try {
    const src = fs.readFileSync(path.join(ROOT, 'astro.config.mjs'), 'utf8');
    const base = src.match(/\bbase\s*:\s*['"`]([^'"`]*)['"`]/);
    const site = src.match(/\bsite\s*:\s*['"`]([^'"`]*)['"`]/);
    if (base) out.base = base[1];
    if (site) out.site = site[1];
  } catch {
    /* 用默认值 */
  }
  if (out.base && !out.base.endsWith('/')) out.base += '/';
  return out;
}

function siteUrl(port, host) {
  const { base } = readAstroConfig();
  const h = host === '0.0.0.0' ? 'localhost' : host;
  return `http://${h}:${port}${base}`;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function clearState() {
  try {
    fs.rmSync(STATE_FILE, { force: true });
  } catch {
    /* 忽略 */
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 存在但不属于当前用户
  }
}

/**
 * Windows 上 .cmd/.bat 必须经 shell 才能启动，而 `shell: true` + 参数数组在 Node 24 会告警，
 * 所以这里显式用 cmd.exe /d /s /c 拼命令（本项目只传固定参数，没有用户输入）。
 */
function npmInvocation(args) {
  if (IS_WIN) {
    return {
      cmd: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', ['npm', ...args].join(' ')],
      shell: false,
    };
  }
  return { cmd: 'npm', args, shell: false };
}

function npmVersion() {
  const inv = npmInvocation(['--version']);
  const r = spawnSync(inv.cmd, inv.args, { encoding: 'utf8' });
  const out = r && r.status === 0 && r.stdout ? String(r.stdout).trim() : '';
  return out || null;
}

function hasNpm() {
  return npmVersion() !== null;
}

/** 找到 astro CLI 入口（不同版本路径不同，所以从 package.json 的 bin 字段解析）。 */
function resolveAstroBin() {
  const pkgPath = path.join(ROOT, 'node_modules', 'astro', 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const bin = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).bin;
      const rel = typeof bin === 'string' ? bin : bin && bin.astro;
      if (rel) {
        const p = path.join(ROOT, 'node_modules', 'astro', rel.replace(/^\.\//, ''));
        if (fs.existsSync(p)) return p;
      }
    } catch {
      /* 继续尝试下面的常见路径 */
    }
  }
  for (const rel of [
    'node_modules/astro/bin/astro.mjs',
    'node_modules/astro/astro.js',
    'node_modules/.bin/astro',
  ]) {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 返回启动 dev server 的命令：优先直接调 astro（不依赖 npm/PATH）。 */
function devCommand(host, port) {
  const astroBin = resolveAstroBin();
  const args = ['dev', '--host', host, '--port', String(port)];
  if (astroBin) return { cmd: process.execPath, args: [astroBin, ...args], shell: false };
  return npmInvocation(['run', 'dev', '--', ...args.slice(1)]);
}

function portFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve(err.code !== 'EADDRINUSE'));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try {
      srv.listen(port, host);
    } catch {
      resolve(false);
    }
  });
}

function probe(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      url,
      { timeout: timeoutMs, agent: false, headers: { 'cache-control': 'no-store' } },
      (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0 });
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
  });
}

function killTree(pid, force = false) {
  if (IS_WIN) {
    // Windows 上 taskkill 不加 /F 只对 GUI 进程发关闭消息，控制台进程（node）不会退出，
    // 所以直接 /T /F 结束整棵进程树 —— dev server 没有需要保存的状态。
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  const sig = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-pid, sig); // 以进程组为单位（start 时用了 detached）
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* 已经退出 */
    }
  }
}

async function waitForExit(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(200);
  }
  return !isAlive(pid);
}

async function waitForServer(url, ms, pid) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await probe(url);
    if (r.ok) return r;
    if (pid && !isAlive(pid)) return { ok: false, status: 0, dead: true };
    await sleep(400);
  }
  return { ok: false, status: 0, dead: false };
}

function tailLog(lines) {
  if (!fs.existsSync(LOG_FILE)) return '(还没有日志)';
  const all = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/);
  return all.slice(-lines).join('\n');
}

function openBrowser(url) {
  let cmd;
  let args;
  if (IS_WIN) {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (IS_MAC) {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

function runForeground(cmd, args, shell = false) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell,
      windowsHide: false,
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      bad(`无法执行 ${cmd}：${err.message}`);
      resolve(1);
    });
  });
}

function checkNode(minor = true) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    warn(
      `当前 Node v${process.versions.node}，博客要求 v${MIN_NODE_MAJOR}+（engines 字段）；` +
        `建议升级后再启动。`,
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- 命令
async function cmdStart() {
  checkNode();
  const existing = readState();
  if (existing && isAlive(existing.pid)) {
    const r = await probe(existing.url);
    ok(`已经在运行：${existing.url}  (PID ${existing.pid})`);
    info(`如需重启：blogctl restart    关闭：blogctl stop    日志：blogctl logs -f`);
    if (opts.open) openBrowser(existing.url);
    return 0;
  }
  if (existing) {
    warn('发现陈旧的状态文件（进程已不存在），已清理。');
    clearState();
  }

  if (!resolveAstroBin()) {
    if (!opts.install) {
      bad('依赖未安装，且指定了 --no-install。先运行：blogctl install');
      return 1;
    }
    if (!hasNpm()) {
      bad(`未找到 npm。请先安装 Node.js ${MIN_NODE_MAJOR}+（自带 npm）后重试。`);
      return 1;
    }
    console.log('首次运行：安装依赖 npm ci …');
    const inv = npmInvocation(['ci', '--no-audit', '--no-fund']);
    const code = spawnSync(inv.cmd, inv.args, { cwd: ROOT, stdio: 'inherit' }).status;
    if (code !== 0 || !resolveAstroBin()) {
      bad('依赖安装失败，请检查网络后重试：blogctl install');
      return 1;
    }
    ok('依赖安装完成');
  }

  // 选端口
  let port = opts.port ?? DEFAULT_PORT;
  if (!(await portFree(port, opts.host))) {
    if (opts.port) {
      bad(`端口 ${port} 已被占用。换个端口：blogctl start --port ${port + 1}`);
      return 1;
    }
    let picked = null;
    for (let p = port + 1; p <= port + 20; p++) {
      if (await portFree(p, opts.host)) {
        picked = p;
        break;
      }
    }
    if (!picked) {
      bad(`端口 ${port}~${port + 20} 都被占用，请用 --port 指定。`);
      return 1;
    }
    warn(`默认端口 ${port} 被占用，改用 ${picked}。`);
    port = picked;
  }

  const url = siteUrl(port, opts.host);
  const { cmd, args, shell } = devCommand(opts.host, port);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const logFd = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(logFd, `\n===== blogctl start ${new Date().toISOString()} =====\n`);

  if (opts.foreground) {
    writeState({ pid: process.pid, port, host: opts.host, url, mode: 'foreground', startedAt: new Date().toISOString(), log: LOG_FILE });
    console.log(`前台启动（Ctrl+C 退出）：${url}`);
    const cleanup = () => clearState();
    process.on('SIGINT', () => {
      cleanup();
      process.exit(0);
    });
    const code = await runForeground(cmd, args, shell);
    cleanup();
    return code;
  }

  const child = spawn(cmd, args, {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    shell,
    windowsHide: true,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', BROWSER: 'none' },
  });
  child.unref();

  writeState({
    pid: child.pid,
    port,
    host: opts.host,
    url,
    mode: 'background',
    startedAt: new Date().toISOString(),
    log: LOG_FILE,
  });

  const spinner = process.stdout.isTTY;
  if (spinner) process.stdout.write('启动中…');
  const r = await waitForServer(url, 30000, child.pid);
  if (spinner) process.stdout.write('\r\u001b[K');

  if (!r.ok) {
    bad(r.dead ? 'dev server 启动后立即退出。日志最后 20 行：' : '等待页面就绪超时。日志最后 20 行：');
    console.log(tailLog(20));
    if (r.dead) clearState();
    return 1;
  }

  ok(`已启动  ${url}  (HTTP ${r.status})`);
  info(`PID ${child.pid} · 端口 ${port} · 日志 ${path.relative(ROOT, LOG_FILE)}`);
  info(`关闭：blogctl stop      重启：blogctl restart      日志：blogctl logs -f`);
  if (opts.open) openBrowser(url);
  return 0;
}

async function cmdStop() {
  const st = readState();
  if (!st || !st.pid) {
    if (!(await portFree(DEFAULT_PORT, DEFAULT_HOST))) {
      warn(
        `默认端口 ${DEFAULT_PORT} 上仍有进程监听，但没有 .blogctl/server.json（可能是别的方式启动的）。` +
          `请手动结束，或用任务管理器/活动监视器处理。`,
      );
      return 1;
    }
    console.log('未在运行。');
    return 0;
  }
  if (!isAlive(st.pid)) {
    clearState();
    console.log('未在运行（清理了陈旧状态文件）。');
    return 0;
  }

  console.log(`关闭 PID ${st.pid}（端口 ${st.port}）…`);
  killTree(st.pid, false);
  if (!(await waitForExit(st.pid, 8000))) {
    warn('普通结束未生效，强制结束。');
    killTree(st.pid, true);
    await waitForExit(st.pid, 5000);
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !(await portFree(st.port, st.host))) await sleep(200);
  clearState();
  ok('已关闭。');
  return 0;
}

async function cmdRestart() {
  const code = await cmdStop();
  if (code !== 0) return code;
  await sleep(500);
  return cmdStart();
}

async function cmdStatus() {
  const st = readState();
  const cfg = readAstroConfig();
  const port = st?.port ?? opts.port ?? DEFAULT_PORT;
  const host = st?.host ?? opts.host;
  const url = st?.url ?? siteUrl(port, host);

  console.log(`博客目录：${ROOT}`);
  console.log(`Node：v${process.versions.node}  平台：${process.platform}`);
  console.log(`站点 base：${cfg.base}${cfg.site ? `   site：${cfg.site}` : ''}`);
  if (!st) {
    console.log('状态：未在运行（无 .blogctl/server.json）');
    const r = await probe(url);
    if (r.ok) warn(`但 ${url} 有响应（进程不是本工具启动的）。`);
    return 0;
  }
  const alive = isAlive(st.pid);
  const r = alive ? await probe(url) : { ok: false, status: 0 };
  console.log(`状态：${alive ? '运行中' : '已停止（状态文件陈旧）'}`);
  console.log(`PID：${st.pid}   端口：${st.port}   启动于：${st.startedAt}`);
  console.log(`URL：${st.url}   HTTP：${r.ok ? r.status : '无响应'}`);
  if (!alive) info('运行 blogctl stop 可清理该状态文件。');
  return 0;
}

async function cmdLogs() {
  const n = Number.isFinite(opts.lines) ? opts.lines : 40;
  console.log(tailLog(n));
  if (!opts.follow) return 0;
  console.log(`\n-- 跟踪 ${path.relative(ROOT, LOG_FILE)}（Ctrl+C 退出）--`);
  let size = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!fs.existsSync(LOG_FILE)) return;
      const s = fs.statSync(LOG_FILE).size;
      if (s < size) size = 0; // 日志被重建
      if (s > size) {
        const fd = fs.openSync(LOG_FILE, 'r');
        const buf = Buffer.alloc(s - size);
        fs.readSync(fd, buf, 0, buf.length, size);
        fs.closeSync(fd);
        process.stdout.write(buf.toString('utf8'));
        size = s;
      }
    }, 500);
    process.on('SIGINT', () => {
      clearInterval(timer);
      console.log('');
      resolve(0);
    });
  });
}

async function cmdOpen() {
  const st = readState();
  const url = st?.url ?? siteUrl(opts.port ?? DEFAULT_PORT, opts.host);
  if (openBrowser(url)) {
    ok(`已在默认浏览器打开 ${url}`);
    return 0;
  }
  bad(`无法自动打开浏览器，请手动访问：${url}`);
  return 1;
}

async function cmdInstall() {
  if (!hasNpm()) {
    bad(`未找到 npm。请先安装 Node.js ${MIN_NODE_MAJOR}+（自带 npm）。`);
    return 1;
  }
  const hasLock = fs.existsSync(path.join(ROOT, 'package-lock.json'));
  console.log(hasLock ? '执行 npm ci …' : '执行 npm install …');
  const inv = npmInvocation(
    hasLock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'],
  );
  const code = spawnSync(inv.cmd, inv.args, { cwd: ROOT, stdio: 'inherit' }).status;
  if (code !== 0) {
    bad('依赖安装失败。');
    return code ?? 1;
  }
  ok('依赖已就绪。');
  return 0;
}

async function runAstro(sub) {
  const astroBin = resolveAstroBin();
  if (!astroBin) {
    bad('依赖未安装。先运行：blogctl install');
    return 1;
  }
  const code = await runForeground(process.execPath, [astroBin, sub]);
  if (code === 0) ok(`astro ${sub} 完成。`);
  else bad(`astro ${sub} 失败（exit ${code}）。`);
  return code;
}

async function cmdDoctor() {
  const major = Number(process.versions.node.split('.')[0]);
  console.log('=== blogctl doctor ===');
  console.log(`平台        : ${process.platform} ${process.arch}`);
  console.log(`Node        : v${process.versions.node} ${major >= MIN_NODE_MAJOR ? '(OK)' : `(需要 >= ${MIN_NODE_MAJOR})`}`);
  console.log(`npm         : ${npmVersion() ?? '未找到（仅安装依赖时需要）'}`);
  console.log(`astro CLI   : ${resolveAstroBin() ?? '未安装（blogctl install）'}`);
  const cfg = readAstroConfig();
  console.log(`site / base : ${cfg.site ?? '(未设置)'} ${cfg.base}`);
  const st = readState();
  console.log(`状态文件    : ${st ? `${STATE_FILE} (PID ${st.pid})` : '无'}`);
  console.log(`默认端口    : ${DEFAULT_PORT} ${(await portFree(DEFAULT_PORT, DEFAULT_HOST)) ? '(空闲)' : '(被占用)'}`);
  if (st && isAlive(st.pid)) {
    const r = await probe(st.url);
    console.log(`当前实例    : ${st.url} HTTP ${r.ok ? r.status : '无响应'}`);
  }
  console.log(`日志文件    : ${fs.existsSync(LOG_FILE) ? `${LOG_FILE} (${(fs.statSync(LOG_FILE).size / 1024).toFixed(1)} KB)` : '无'}`);
  return 0;
}

function cmdHelp() {
  const pkg = readPkg();
  console.log(`blogctl ${pkg.version ?? ''} —— 博客本地预览一键启动/关闭（Windows · macOS · Linux）

用法
  blogctl <命令> [选项]
  Windows:  .\\blogctl.cmd start      或  blogctl start（cmd） 或  node blogctl.mjs start
  macOS  :  ./blogctl start           或  bash blogctl start   或  node blogctl.mjs start

命令
  start      启动本地预览（默认后台）；首次会自动 npm ci 安装依赖
  stop       关闭本地预览（含子进程）
  restart    重启
  status     查看运行状态 / PID / 端口 / HTTP 响应
  logs       查看日志（-n 行数，-f 跟踪）
  open       用默认浏览器打开
  install    安装依赖（npm ci）
  build      构建静态站点到 dist/
  check      astro check 类型检查
  doctor     环境自检
  help       本帮助        version  版本号

选项
  -p, --port <n>    端口，默认 ${DEFAULT_PORT}（占用时自动顺延）
      --host <h>    监听地址，默认 ${DEFAULT_HOST}
  -o, --open        启动后打开浏览器
      --foreground  前台运行（Ctrl+C 退出），默认后台
      --no-install  依赖缺失时不自动安装
  -n, --lines <n>   logs 显示的行数（默认 40）
  -f, --follow      logs 持续跟踪输出

示例
  blogctl                 # 一键启动（= start）
  blogctl start --open    # 启动并打开浏览器
  blogctl logs -f         # 实时看日志
  blogctl stop            # 关闭
`);
  return 0;
}

function cmdVersion() {
  const pkg = readPkg();
  console.log(pkg.version ?? 'unknown');
  return 0;
}

// ---------------------------------------------------------------- 入口
const COMMANDS = {
  start: cmdStart,
  up: cmdStart,
  serve: cmdStart,
  stop: cmdStop,
  down: cmdStop,
  restart: cmdRestart,
  status: cmdStatus,
  st: cmdStatus,
  logs: cmdLogs,
  log: cmdLogs,
  open: cmdOpen,
  install: cmdInstall,
  build: () => runAstro('build'),
  check: () => runAstro('check'),
  doctor: cmdDoctor,
  help: cmdHelp,
  version: cmdVersion,
};

const isKnown = Object.prototype.hasOwnProperty.call(COMMANDS, command);
if (!isKnown) {
  bad(`未知命令：${command}`);
  cmdHelp();
  process.exit(2);
}

const handler = COMMANDS[command];
try {
  const code = await handler();
  process.exit(typeof code === 'number' ? code : 0);
} catch (err) {
  bad(`执行出错：${err && err.message ? err.message : err}`);
  process.exit(1);
}
