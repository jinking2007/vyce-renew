export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const RENEWAL_ADDED_MS = 48 * HOUR_MS;

export function toTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 站点返回毫秒时间戳；兼容秒级时间戳。
    return value < 1e11 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 复刻站点前端的续期判定逻辑（Hy 函数）：
 * - 只有 source === 'free' 的服务器需要续期；
 * - 已暂停 / 创建中的服务器跳过；
 * - 非 running（已关机）的免费服务器随时可续期并开机；
 * - running 且剩余时间 > 阈值（默认 24h）时为冷却期，不能续期。
 */
export function computeRenewalDecision(server, now = Date.now(), { thresholdHours = 24 } = {}) {
  const thresholdMs = thresholdHours * HOUR_MS;
  const expiresAt = toTimestamp(server?.expiresAt);

  if (!server || server.source !== 'free') {
    return { action: 'skip', reason: 'paid', expiresAt, remainingMs: null, cooldownMs: 0 };
  }
  if (server.suspended) {
    return { action: 'skip', reason: 'suspended', expiresAt, remainingMs: null, cooldownMs: 0 };
  }
  if (server.status === 'creating') {
    return { action: 'skip', reason: 'creating', expiresAt, remainingMs: null, cooldownMs: 0 };
  }
  if (expiresAt === null) {
    return { action: 'skip', reason: 'no-expiry', expiresAt, remainingMs: null, cooldownMs: 0 };
  }

  const remainingMs = expiresAt - now;

  if (server.status !== 'running') {
    return { action: 'renew', reason: 'stopped', expiresAt, remainingMs, cooldownMs: 0 };
  }
  if (remainingMs > thresholdMs) {
    return {
      action: 'skip',
      reason: 'cooldown',
      expiresAt,
      remainingMs,
      cooldownMs: remainingMs - thresholdMs,
    };
  }
  return {
    action: 'renew',
    reason: remainingMs <= 0 ? 'late' : 'due',
    expiresAt,
    remainingMs,
    cooldownMs: 0,
  };
}

export function matchesServer(server, selector) {
  const needle = selector.trim().toLowerCase();
  if (!needle) {
    return false;
  }
  return (
    String(server?.id ?? '').toLowerCase() === needle ||
    String(server?.name ?? '').toLowerCase() === needle
  );
}

export function selectServers(servers, selectors = []) {
  if (!Array.isArray(servers)) {
    return [];
  }
  if (!selectors || selectors.length === 0) {
    return servers;
  }
  return servers.filter((server) => selectors.some((selector) => matchesServer(server, selector)));
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Math.abs(ms) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days >= 1) {
    return `${days}天 ${hours}小时`;
  }
  if (hours >= 1) {
    return `${hours}小时 ${String(minutes).padStart(2, '0')}分`;
  }
  if (minutes >= 1) {
    return `${minutes}分 ${String(seconds).padStart(2, '0')}秒`;
  }
  return `${seconds}秒`;
}

export function formatTimestamp(value) {
  const timestamp = toTimestamp(value);
  if (timestamp === null) {
    return '未知';
  }
  return new Date(timestamp).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}
