import { buildProxyUrl } from './vyce-client.js';
import { isVlessUrl, startSingBoxProxy } from './sing-box.js';

/**
 * 解析代理配置：
 * - PROXY_URL=vless://... → 启动 sing-box，返回本地 mixed 代理
 * - http(s)/socks5://...  → 直接使用
 * - 未配置 → 直连
 * 返回值中的 stop 必须在命令结束时调用。
 */
export async function resolveProxyRuntime(config, logger) {
  const url = String(config.proxyUrl || config.proxyServer || '').trim();
  if (!url) {
    return { proxy: null, stop: async () => {}, kind: 'none' };
  }

  if (isVlessUrl(url)) {
    const singBox = await startSingBoxProxy({
      vlessUrl: url,
      binaryPath: config.singBoxPath,
      version: config.singBoxVersion,
      logger,
    });
    return {
      proxy: { server: singBox.server },
      stop: singBox.stop,
      kind: 'vless',
    };
  }

  // 提前校验 http/socks 地址，避免 Playwright/undici 抛难懂的错误。
  buildProxyUrl({ server: url });
  return {
    proxy: {
      server: url,
      username: config.proxyUsername,
      password: config.proxyPassword,
    },
    stop: async () => {},
    kind: 'direct-proxy',
  };
}
