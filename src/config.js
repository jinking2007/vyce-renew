import path from 'node:path';
import process from 'node:process';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function readString(env, name, fallback = '') {
  const value = env[name];
  if (value === undefined || value === null) {
    return fallback;
  }
  const trimmed = String(value).trim();
  return trimmed === '' ? fallback : trimmed;
}

function readNumber(env, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = readString(env, name);
  if (raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`环境变量 ${name} 的值无效: ${raw}`);
  }
  return value;
}

function readBoolean(env, name, fallback) {
  const raw = readString(env, name).toLowerCase();
  if (raw === '') {
    return fallback;
  }
  if (TRUE_VALUES.has(raw)) {
    return true;
  }
  if (FALSE_VALUES.has(raw)) {
    return false;
  }
  throw new Error(`环境变量 ${name} 的值无效: ${raw}（可用 true/false）`);
}

function readList(env, name) {
  return readString(env, name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const baseUrl = readString(env, 'VYCE_BASE_URL', 'https://vyce.cloud').replace(/\/+$/, '');
  const statePath = path.resolve(readString(env, 'VYCE_STATE_PATH', '.auth/state.json'));

  const notifyRaw = readString(env, 'TELEGRAM_NOTIFY', 'true').toLowerCase();
  const telegramNotifyAlways = notifyRaw === 'always';
  const telegramNotify = telegramNotifyAlways ? true : readBoolean(env, 'TELEGRAM_NOTIFY', true);

  return {
    baseUrl,
    cookie: readString(env, 'VYCE_COOKIE'),
    statePath,
    serverSelectors: readList(env, 'VYCE_SERVERS'),
    thresholdHours: readNumber(env, 'VYCE_THRESHOLD_HOURS', 24, { min: 0, max: 24 }),
    cooldownGraceMinutes: readNumber(env, 'VYCE_COOLDOWN_GRACE_MINUTES', 5, { min: 0, max: 8 }),
    intervalHours: readNumber(env, 'VYCE_INTERVAL_HOURS', 24, { min: 0.1, max: 24 * 30 }),
    dryRun: readBoolean(env, 'VYCE_DRY_RUN', false),
    headless: readBoolean(env, 'VYCE_HEADLESS', true),
    loginTimeoutSeconds: readNumber(env, 'VYCE_LOGIN_TIMEOUT_SECONDS', 600, { min: 30, max: 3600 }),
    timeoutMs: readNumber(env, 'VYCE_TIMEOUT_MS', 20000, { min: 1000, max: 120000 }),
    telegramBotToken: readString(env, 'TELEGRAM_BOT_TOKEN'),
    telegramChatId: readString(env, 'TELEGRAM_CHAT_ID'),
    telegramApiBase: readString(env, 'TELEGRAM_API_BASE', 'https://api.telegram.org').replace(/\/+$/, ''),
    telegramNotify,
    telegramNotifyAlways,
    captchaBrowser: readBoolean(env, 'VYCE_CAPTCHA_BROWSER', true),
    captchaHeadful: readBoolean(env, 'VYCE_CAPTCHA_HEADFUL', env.CI === 'true' || env.GITHUB_ACTIONS === 'true'),
    captchaTimeoutSeconds: readNumber(env, 'VYCE_CAPTCHA_TIMEOUT_SECONDS', 60, { min: 10, max: 300 }),
    browserChannel: readString(env, 'VYCE_BROWSER_CHANNEL'),
    proxyUrl: readString(env, 'PROXY_URL') || readString(env, 'VYCE_PROXY_URL'),
    proxyServer: readString(env, 'VYCE_PROXY_SERVER'),
    proxyUsername: readString(env, 'VYCE_PROXY_USERNAME'),
    proxyPassword: readString(env, 'VYCE_PROXY_PASSWORD'),
    singBoxPath: path.resolve(readString(env, 'VYCE_SING_BOX_PATH', '.cache/sing-box')),
    singBoxVersion: readString(env, 'VYCE_SING_BOX_VERSION', '1.14.4'),
  };
}
