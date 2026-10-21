/**
 * Cookie 相关工具：既支持 VYCE_COOKIE 里的 "a=1; b=2" 字符串，
 * 也支持 Playwright storageState（.auth/state.json）里的 cookies 数组。
 */

export function parseCookieString(raw) {
  if (!raw || typeof raw !== 'string') {
    return [];
  }
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=');
      if (index <= 0) {
        return null;
      }
      return {
        name: part.slice(0, index).trim(),
        value: part.slice(index + 1).trim(),
      };
    })
    .filter((cookie) => cookie && cookie.name);
}

export function cookieDomainMatches(domain, host = 'vyce.cloud') {
  if (!domain) {
    return false;
  }
  const normalized = String(domain).replace(/^\./, '').toLowerCase();
  return host.toLowerCase() === normalized || host.toLowerCase().endsWith(`.${normalized}`);
}

export function cookieHeaderFromState(state, { now = Date.now(), host = 'vyce.cloud' } = {}) {
  const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
  return cookies
    .filter((cookie) => cookie && cookie.name && cookieDomainMatches(cookie.domain, host))
    .filter((cookie) => {
      const expires = Number(cookie.expires);
      // expires <= 0 表示会话 Cookie，仍然有效。
      return !Number.isFinite(expires) || expires <= 0 || expires * 1000 > now;
    })
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}
