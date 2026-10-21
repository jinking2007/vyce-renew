import fs from 'node:fs';
import process from 'node:process';
import { cookieHeaderFromState } from './cookies.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class VyceError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'VyceError';
    this.status = status;
    this.code = code;
  }
}

export class VyceAuthError extends VyceError {
  constructor(message = '登录会话无效或已过期，请重新登录。') {
    super(message, { status: 401, code: 'unauthenticated' });
    this.name = 'VyceAuthError';
  }
}

export class VyceApiError extends VyceError {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message, { status, code });
    this.name = 'VyceApiError';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response, attempt) {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 30000);
  }
  return Math.min(1000 * 2 ** attempt, 8000);
}

export function resolveCookieHeader({ cookie = '', statePath = '' } = {}) {
  if (cookie) {
    return cookie;
  }
  if (!statePath || !fs.existsSync(statePath)) {
    return '';
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return '';
  }
  return cookieHeaderFromState(state);
}

export class VyceClient {
  constructor({ baseUrl = 'https://vyce.cloud', cookie = '', statePath = '', timeoutMs = 20000, retries = 2, logger } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.cookie = cookie;
    this.statePath = statePath;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.logger = logger;
  }

  get hasCredentials() {
    return Boolean(resolveCookieHeader({ cookie: this.cookie, statePath: this.statePath }));
  }

  async request(method, endpoint, { body } = {}) {
    const cookieHeader = resolveCookieHeader({ cookie: this.cookie, statePath: this.statePath });
    if (!cookieHeader) {
      throw new VyceAuthError(
        `没有找到登录会话。请先运行 "npm run login" 登录一次，或设置 VYCE_COOKIE 环境变量（会话文件: ${this.statePath || '未配置'}）。`,
      );
    }

    const url = `${this.baseUrl}/api${endpoint}`;
    const headers = {
      accept: 'application/json',
      'accept-language': 'en-US,en;q=0.9',
      cookie: cookieHeader,
      // 站点会校验 POST 请求的 Origin，缺少或错误时返回 403 bad_origin。
      origin: this.baseUrl,
      referer: `${this.baseUrl}/`,
      'user-agent': DEFAULT_USER_AGENT,
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      let response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        lastError = new VyceApiError(
          `无法连接 ${url}：${error?.cause?.message || error?.message || error}`,
          { status: 0, code: 'network' },
        );
        if (attempt < this.retries) {
          await sleep(Math.min(1000 * 2 ** attempt, 8000));
          continue;
        }
        throw lastError;
      }

      const text = await response.text();
      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { message: text.slice(0, 300) };
        }
      }

      if (response.ok) {
        return data;
      }

      if (response.status === 401) {
        throw new VyceAuthError(data.message || '登录会话无效或已过期，请重新运行 "npm run login"。');
      }

      const apiError = new VyceApiError(data.message || `请求失败（HTTP ${response.status}）`, {
        status: response.status,
        code: data.error || '',
      });

      if ((response.status === 429 || response.status >= 500) && attempt < this.retries) {
        lastError = apiError;
        this.logger?.warn(`${endpoint} 返回 HTTP ${response.status}，稍后重试（${attempt + 1}/${this.retries}）...`);
        await sleep(retryDelayMs(response, attempt));
        continue;
      }

      throw apiError;
    }

    throw lastError ?? new VyceApiError('请求失败');
  }

  async getMe() {
    const data = await this.request('GET', '/me');
    if (!data?.user) {
      throw new VyceAuthError('未能获取账号信息，登录状态可能已失效。');
    }
    return data.user;
  }

  async listServers() {
    const data = await this.request('GET', '/servers');
    return Array.isArray(data?.servers) ? data.servers : [];
  }

  async getServer(id) {
    const data = await this.request('GET', `/servers/${encodeURIComponent(id)}`);
    return data?.server ?? null;
  }

  async renewServer(id) {
    return this.request('POST', `/servers/${encodeURIComponent(id)}/renew`);
  }
}
