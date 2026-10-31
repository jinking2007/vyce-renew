import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export const DEFAULT_SING_BOX_VERSION = '1.14.4';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isVlessUrl(value) {
  return /^vless:\/\//i.test(String(value || '').trim());
}

/**
 * 把 vless:// 链接转换成 sing-box 的 outbound 配置。
 * 支持 tcp/ws/grpc/http，tls/reality，以及常见的 sni/fp/alpn/flow 参数。
 */
export function parseVlessUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new Error('PROXY_URL 不是合法的 VLESS 链接。');
  }
  if (url.protocol !== 'vless:') {
    throw new Error(`PROXY_URL 协议必须是 vless://，当前是 ${url.protocol}`);
  }

  const uuid = decodeURIComponent(url.username);
  if (!uuid) {
    throw new Error('VLESS 链接缺少 UUID。');
  }
  const server = url.hostname;
  const serverPort = Number(url.port || 443);
  if (!server || !Number.isFinite(serverPort)) {
    throw new Error('VLESS 链接缺少服务器地址或端口。');
  }

  const params = url.searchParams;
  const security = (params.get('security') || 'none').toLowerCase();
  const type = (params.get('type') || 'tcp').toLowerCase();

  const outbound = {
    type: 'vless',
    tag: 'proxy',
    server,
    server_port: serverPort,
    uuid,
  };

  const flow = params.get('flow');
  if (flow) {
    outbound.flow = flow;
  }

  const host = params.get('host') || '';
  const sni = params.get('sni') || host || server;

  if (security === 'tls' || security === 'reality') {
    outbound.tls = {
      enabled: true,
      server_name: sni,
    };
    const fingerprint = params.get('fp');
    if (fingerprint) {
      outbound.tls.utls = { enabled: true, fingerprint };
    }
    const alpn = params.get('alpn');
    if (alpn) {
      outbound.tls.alpn = alpn
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
    if (params.get('allowInsecure') === '1' || params.get('insecure') === '1') {
      outbound.tls.insecure = true;
    }
    if (security === 'reality') {
      const publicKey = params.get('pbk');
      if (!publicKey) {
        throw new Error('VLESS reality 链接缺少 pbk 参数。');
      }
      outbound.tls.reality = {
        enabled: true,
        public_key: publicKey,
        short_id: params.get('sid') || '',
      };
    }
  }

  if (type === 'ws') {
    outbound.transport = {
      type: 'ws',
      path: params.get('path') || '/',
    };
    if (host) {
      outbound.transport.headers = { Host: host };
    }
  } else if (type === 'grpc') {
    outbound.transport = {
      type: 'grpc',
      service_name: params.get('serviceName') || params.get('path') || '',
    };
  } else if (type === 'http' || type === 'h2') {
    outbound.transport = {
      type: 'http',
      path: params.get('path') || '/',
    };
    if (host) {
      outbound.transport.host = host
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
  } else if (type !== 'tcp') {
    throw new Error(`暂不支持的 VLESS 传输类型：${type}`);
  }

  return outbound;
}

export function buildSingBoxConfig(outbound, listenPort) {
  return {
    log: { level: 'warn', timestamp: true },
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: listenPort,
      },
    ],
    outbounds: [outbound, { type: 'direct', tag: 'direct' }],
    route: { final: 'proxy' },
  };
}

function platformInfo() {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  return {
    osName: platform,
    archName: arch,
    ext: process.platform === 'win32' ? 'zip' : 'tar.gz',
    binaryName: process.platform === 'win32' ? 'sing-box.exe' : 'sing-box',
  };
}

function findFile(dir, fileName) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return full;
    }
    if (entry.isDirectory()) {
      const found = findFile(full, fileName);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`下载 sing-box 失败：HTTP ${response.status}（${url}）`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
}

export async function ensureSingBoxBinary({
  binaryPath,
  version = DEFAULT_SING_BOX_VERSION,
  logger,
} = {}) {
  if (binaryPath && fs.existsSync(binaryPath)) {
    return binaryPath;
  }

  const { osName, archName, ext, binaryName } = platformInfo();
  const target = binaryPath || path.resolve('.cache', binaryName);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const asset = `sing-box-${version}-${osName}-${archName}.${ext}`;
  const url = `https://github.com/SagerNet/sing-box/releases/download/v${version}/${asset}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sing-box-'));
  const archive = path.join(tmpDir, asset);

  try {
    logger?.info(`未找到 sing-box，正在下载 v${version}（${osName}-${archName}）...`);
    await downloadFile(url, archive);

    if (ext === 'zip') {
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${tmpDir}' -Force`],
        { stdio: 'pipe' },
      );
    } else {
      execFileSync('tar', ['-xzf', archive, '-C', tmpDir], { stdio: 'pipe' });
    }

    const extracted = findFile(tmpDir, binaryName);
    if (!extracted) {
      throw new Error('sing-box 压缩包中未找到可执行文件。');
    }
    fs.copyFileSync(extracted, target);
    fs.chmodSync(target, 0o755);
    logger?.info(`sing-box 已准备：${target}`);
    return target;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port, child, timeoutMs, logPath) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').slice(-1000) : '';
      throw new Error(`sing-box 启动失败（exit ${child.exitCode}）：${log || '无日志'}`);
    }
    const connected = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const finish = (value) => {
        socket.destroy();
        resolve(value);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(800, () => finish(false));
    });
    if (connected) {
      return;
    }
    await sleep(250);
  }
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').slice(-1000) : '';
  throw new Error(`等待 sing-box 本地代理端口超时：${log || '无日志'}`);
}

/**
 * 根据 VLESS 链接启动一个本地 mixed 代理，返回 { server, stop }。
 * 只监听 127.0.0.1，配置写完后立即删除，UUID 不会长期落盘。
 */
export async function startSingBoxProxy({
  vlessUrl,
  binaryPath,
  version = DEFAULT_SING_BOX_VERSION,
  logger,
} = {}) {
  const outbound = parseVlessUrl(vlessUrl);
  const binary = await ensureSingBoxBinary({ binaryPath, version, logger });
  const port = await getFreePort();

  const cacheDir = path.resolve('.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const configPath = path.join(cacheDir, `sing-box-${process.pid}-${Date.now()}.json`);
  const logPath = path.join(cacheDir, `sing-box-${process.pid}-${Date.now()}.log`);
  fs.writeFileSync(configPath, JSON.stringify(buildSingBoxConfig(outbound, port), null, 2), { mode: 0o600 });

  logger?.info(`启动 sing-box：${outbound.server}:${outbound.server_port} → 本地代理 127.0.0.1:${port}`);
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(binary, ['run', '-c', configPath], {
    stdio: ['ignore', 'ignore', logFd],
  });
  fs.closeSync(logFd);

  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    const exited = await Promise.race([
      new Promise((resolve) => child.once('exit', () => resolve(true))),
      sleep(3000).then(() => false),
    ]);
    if (!exited) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    fs.rmSync(configPath, { force: true });
  };

  const onExit = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
    fs.rmSync(configPath, { force: true });
  };
  process.once('exit', onExit);

  try {
    await waitForPort(port, child, 20000, logPath);
  } catch (error) {
    await stop();
    throw error;
  }

  // 启动成功后删除配置，避免 UUID 留在磁盘上。
  fs.rmSync(configPath, { force: true });
  child.once('exit', () => {
    process.removeListener('exit', onExit);
  });

  return {
    server: `http://127.0.0.1:${port}`,
    port,
    stop,
  };
}

