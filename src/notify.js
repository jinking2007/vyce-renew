import { formatTimestamp } from './decisions.js';

const MAX_MESSAGE_LENGTH = 4000;

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function truncate(text) {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_MESSAGE_LENGTH - 30)}\n…（消息过长已截断）`;
}

function accountLabel(summary) {
  const user = summary?.user;
  return user?.login || user?.name || user?.id || '未知账号';
}

function serverLabel(server) {
  return server?.name || server?.id || '未命名服务器';
}

function consoleLink(baseUrl) {
  return `<a href="${escapeHtml(`${baseUrl}/#/servers`)}">打开服务器控制台</a>`;
}

export function buildApiMessage(summary, { baseUrl = 'https://vyce.cloud', dryRun = false, now = Date.now() } = {}) {
  const renewed = Array.isArray(summary?.renewed) ? summary.renewed : [];
  const planned = Array.isArray(summary?.planned) ? summary.planned : [];
  const skipped = Array.isArray(summary?.skipped) ? summary.skipped : [];
  const failed = Array.isArray(summary?.failed) ? summary.failed : [];
  const lines = [];

  const icon = failed.length > 0 ? '⚠️' : dryRun ? '🧪' : '✅';
  lines.push(`<b>${icon} vyce.cloud ${dryRun ? '续期预检' : '自动续期'}</b>`);
  lines.push(`账号：<b>${escapeHtml(accountLabel(summary))}</b>`);
  lines.push(`时间：${formatTimestamp(now)}`);
  lines.push('');

  if (renewed.length > 0) {
    lines.push(`<b>✅ 续期成功：${renewed.length} 台</b>`);
    for (const item of renewed) {
      lines.push(
        `• <b>${escapeHtml(serverLabel(item.server))}</b>：` +
          `${formatTimestamp(item.previousExpiresAt)} → ${formatTimestamp(item.expiresAt)}`,
      );
    }
  }

  if (planned.length > 0) {
    lines.push(`<b>🧪 计划续期：${planned.length} 台</b>`);
    for (const item of planned) {
      lines.push(`• <b>${escapeHtml(serverLabel(item.server))}</b>：到期 ${formatTimestamp(item.decision?.expiresAt)}`);
    }
  }

  if (failed.length > 0) {
    lines.push(`<b>❌ 续期失败：${failed.length} 台</b>`);
    for (const item of failed) {
      lines.push(`• <b>${escapeHtml(serverLabel(item.server))}</b>：${escapeHtml(item.error?.message || item.error)}`);
    }
  }

  if (skipped.length > 0) {
    const cooldown = skipped.filter((item) => item.decision?.reason === 'cooldown').length;
    lines.push(`跳过：${skipped.length} 台${cooldown > 0 ? `（冷却中 ${cooldown} 台）` : ''}`);
  }

  if (lines[lines.length - 1] !== '') {
    lines.push('');
  }
  lines.push(consoleLink(baseUrl));

  return truncate(lines.join('\n'));
}

export function buildUiMessage(summary, { baseUrl = 'https://vyce.cloud', now = Date.now() } = {}) {
  const succeeded = Number(summary?.succeeded || 0);
  const failed = Number(summary?.failed || 0);
  const clicked = Number(summary?.clicked || 0);
  const messages = Array.isArray(summary?.messages) ? summary.messages : [];

  const lines = [
    `<b>${failed > 0 ? '⚠️' : '✅'} vyce.cloud 浏览器续期</b>`,
    `时间：${formatTimestamp(now)}`,
    `点击次数：${clicked}，成功 ${succeeded} 台，失败 ${failed} 台`,
  ];

  for (const message of messages.slice(0, 10)) {
    lines.push(`• ${escapeHtml(message)}`);
  }

  lines.push('', consoleLink(baseUrl));
  return truncate(lines.join('\n'));
}

export function buildFailureMessage(error, { baseUrl = 'https://vyce.cloud', now = Date.now() } = {}) {
  const message = error?.message || String(error);
  const status = error?.status ? `（HTTP ${error.status}）` : '';
  const lines = [
    '<b>❌ vyce.cloud 续期失败</b>',
    `时间：${formatTimestamp(now)}`,
    `错误：<code>${escapeHtml(message)}${escapeHtml(status)}</code>`,
  ];

  if (error?.status === 401 || error?.name === 'VyceAuthError') {
    lines.push('提示：登录会话可能已过期。请重新运行 <code>npm run login</code>，并更新 <code>VYCE_COOKIE</code> Secret。');
  } else {
    lines.push('提示：请登录服务器查看日志，确认网络和 Cookie 是否正常。');
  }

  lines.push('', consoleLink(baseUrl));
  return truncate(lines.join('\n'));
}

export function buildTestMessage({ now = Date.now() } = {}) {
  return [
    '<b>✅ vyce.cloud 通知测试</b>',
    `时间：${formatTimestamp(now)}`,
    '如果你收到这条消息，说明 Telegram 通知配置成功。',
  ].join('\n');
}


export function isTelegramConfigured(config) {
  return Boolean(config?.telegramNotify && config?.telegramBotToken && config?.telegramChatId);
}

export async function sendTelegramMessage({
  token,
  chatId,
  apiBase = 'https://api.telegram.org',
  text,
  timeoutMs = 10000,
  fetchImpl = fetch,
}) {
  if (!token || !chatId) {
    throw new Error('未配置 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID。');
  }

  const url = `${apiBase.replace(/\/+$/, '')}/bot${token}/sendMessage`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`无法连接 Telegram API：${error?.cause?.message || error?.message || error}`);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(`Telegram API 返回错误：${data.description || `HTTP ${response.status}`}`);
  }
  return data.result ?? data;
}

function redact(text, secret) {
  const value = String(text ?? '');
  return secret ? value.split(secret).join('***') : value;
}

async function deliver({ config, logger, text, fetchImpl }) {
  if (!isTelegramConfigured(config)) {
    return { sent: false, reason: 'not-configured' };
  }
  try {
    await sendTelegramMessage({
      token: config.telegramBotToken,
      chatId: config.telegramChatId,
      apiBase: config.telegramApiBase,
      text,
      timeoutMs: Math.min(config.timeoutMs ?? 10000, 15000),
      fetchImpl,
    });
    logger?.info('Telegram 通知已发送。');
    return { sent: true };
  } catch (error) {
    // 通知失败不应该影响续期结果，只记录警告（绝不打印 Token）。
    logger?.warn(`Telegram 通知发送失败：${redact(error.message, config.telegramBotToken)}`);
    return { sent: false, reason: 'error', error };
  }
}

export async function notifyApiResult({ config, logger, summary, dryRun = false, fetchImpl }) {
  if (!isTelegramConfigured(config)) {
    return { sent: false, reason: 'not-configured' };
  }
  const hasNews =
    (summary?.renewed?.length ?? 0) > 0 ||
    (summary?.planned?.length ?? 0) > 0 ||
    (summary?.failed?.length ?? 0) > 0;
  if (!hasNews) {
    return { sent: false, reason: 'nothing-to-report' };
  }
  return deliver({
    config,
    logger,
    text: buildApiMessage(summary, { baseUrl: config.baseUrl, dryRun }),
    fetchImpl,
  });
}

export async function notifyUiResult({ config, logger, summary, fetchImpl }) {
  if (!isTelegramConfigured(config)) {
    return { sent: false, reason: 'not-configured' };
  }
  if ((summary?.succeeded ?? 0) === 0 && (summary?.failed ?? 0) === 0) {
    return { sent: false, reason: 'nothing-to-report' };
  }
  return deliver({
    config,
    logger,
    text: buildUiMessage(summary, { baseUrl: config.baseUrl }),
    fetchImpl,
  });
}

export async function notifyFailure({ config, logger, error, fetchImpl }) {
  return deliver({
    config,
    logger,
    text: buildFailureMessage(error, { baseUrl: config.baseUrl }),
    fetchImpl,
  });
}

export async function notifyTest({ config, logger, fetchImpl }) {
  if (!isTelegramConfigured(config)) {
    throw new Error(
      'Telegram 通知未配置或已关闭。请设置 TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID（可同时设置 TELEGRAM_NOTIFY=true）。',
    );
  }
  await sendTelegramMessage({
    token: config.telegramBotToken,
    chatId: config.telegramChatId,
    apiBase: config.telegramApiBase,
    text: buildTestMessage(),
    timeoutMs: config.timeoutMs,
    fetchImpl,
  });
  logger?.info(`Telegram 测试消息已发送到 chat_id ${config.telegramChatId}。`);
  return { sent: true };
}
