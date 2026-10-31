import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { buildProxyUrl } from './vyce-client.js';
import { isVlessUrl, startSingBoxProxy } from './sing-box.js';

const COUNTRY_PROFILE = {
  AU: { timezoneId: 'Australia/Sydney', locale: 'en-AU' },
  CA: { timezoneId: 'America/Toronto', locale: 'en-CA' },
  CN: { timezoneId: 'Asia/Shanghai', locale: 'zh-CN' },
  DE: { timezoneId: 'Europe/Berlin', locale: 'de-DE' },
  FR: { timezoneId: 'Europe/Paris', locale: 'fr-FR' },
  GB: { timezoneId: 'Europe/London', locale: 'en-GB' },
  HK: { timezoneId: 'Asia/Hong_Kong', locale: 'en-HK' },
  JP: { timezoneId: 'Asia/Tokyo', locale: 'ja-JP' },
  KR: { timezoneId: 'Asia/Seoul', locale: 'ko-KR' },
  NL: { timezoneId: 'Europe/Amsterdam', locale: 'nl-NL' },
  SG: { timezoneId: 'Asia/Singapore', locale: 'en-SG' },
  TW: { timezoneId: 'Asia/Taipei', locale: 'zh-TW' },
  US: { timezoneId: 'America/New_York', locale: 'en-US' },
};

async function probeExitIp(proxy, logger) {
  if (!proxy?.server) {
    return null;
  }
  let dispatcher;
  try {
    dispatcher = new ProxyAgent(buildProxyUrl(proxy) || proxy.server);
  } catch {
    return null;
  }

  const ips = [];
  let country = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await undiciFetch('https://www.cloudflare.com/cdn-cgi/trace', {
        dispatcher,
        signal: AbortSignal.timeout(10000),
      });
      const text = await response.text();
      const ip = /^ip=(.+)$/m.exec(text)?.[1]?.trim();
      if (ip) {
        ips.push(ip);
      }
      const loc = /^loc=([A-Z]{2})$/m.exec(text)?.[1];
      if (loc) {
        country = loc;
      }
    } catch (error) {
      logger?.warn(`代理出口 IP 检测失败：${error?.message || error}`);
      return null;
    }
  }

  if (ips.length > 0) {
    logger?.info(`代理出口 IP：${ips.join(' / ')}${country ? `（${country}）` : ''}`);
    if (ips.length > 1 && ips[0] !== ips[1]) {
      logger?.warn('代理出口 IP 不稳定（两次检测不同），CAPTCHA token 可能与续期请求的 IP 不一致。');
    }
  }

  const profile = COUNTRY_PROFILE[country] || null;
  if (profile) {
    logger?.info(`浏览器时区/语言将对齐出口：${profile.timezoneId} / ${profile.locale}`);
  }
  return profile;
}

/**
 * 解析代理配置：
 * - PROXY_URL=vless://... → 启动 sing-box，返回本地 mixed 代理
 * - http(s)/socks5://...  → 直接使用
 * - 未配置 → 直连
 * 返回值中的 stop 必须在命令结束时调用。
 */
export async function resolveProxyRuntime(config, logger, { probe = true } = {}) {
  const url = String(config.proxyUrl || config.proxyServer || '').trim();
  if (!url) {
    return { proxy: null, stop: async () => {}, kind: 'none', profile: null };
  }

  if (isVlessUrl(url)) {
    const singBox = await startSingBoxProxy({
      vlessUrl: url,
      binaryPath: config.singBoxPath,
      version: config.singBoxVersion,
      logger,
    });
    const proxy = { server: singBox.server };
    const profile = probe ? await probeExitIp(proxy, logger) : null;
    return {
      proxy,
      stop: singBox.stop,
      kind: 'vless',
      profile,
    };
  }

  // 提前校验 http/socks 地址，避免 Playwright/undici 抛难懂的错误。
  buildProxyUrl({ server: url });
  const proxy = {
    server: url,
    username: config.proxyUsername,
    password: config.proxyPassword,
  };
  const profile = probe ? await probeExitIp(proxy, logger) : null;
  return {
    proxy,
    stop: async () => {},
    kind: 'direct-proxy',
    profile,
  };
}
