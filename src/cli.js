#!/usr/bin/env node
import process from 'node:process';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { createLogger, describeError } from './logger.js';
import { HOUR_MS, computeRenewalDecision, formatDuration, formatTimestamp, selectServers } from './decisions.js';
import { VyceAuthError, VyceClient, resolveCookieHeader } from './vyce-client.js';
import { runRenewal } from './renew.js';
import { loginWithBrowser, renewViaUi } from './browser.js';
import { notifyApiResult, notifyFailure, notifyTest, notifyUiResult } from './notify.js';

const HELP = `
vyce.cloud 自动续期工具

用法:
  npm run login            在浏览器中用 GitHub 登录一次，并保存会话
  npm run renew            检查并续期到期的免费服务器（API 模式）
  npm run renew:ui         打开浏览器，真实点击 Renew 按钮
  npm run status           查看账号下服务器状态
  npm run daemon           常驻运行，每 24 小时自动续期
  npm run export-cookie    打印 Cookie，用于配置 GitHub Actions Secret
  npm run notify-test      发送一条 Telegram 测试消息

常用选项:
  --dry-run                只打印将要执行的操作，不真正续期
  --ui                     使用浏览器点击方式续期
  --headed                 显示浏览器窗口（配合 --ui 使用）
  --json                   以 JSON 输出结果（日志仍输出到 stderr）
  --no-notify              本次不发送 Telegram 通知
  --once                   配合 daemon：只运行一次
  --interval <小时>        配合 daemon：覆盖检查间隔
  -h, --help               显示帮助

环境变量见 .env.example 或 README.md。
`;

function toJson(value) {
  return JSON.stringify(value, null, 2);
}

function describeUser(user) {
  return `${user.login || user.name || user.id}（GitHub ID: ${user.githubId ?? user.id}）`;
}

function proxyFromConfig(config) {
  if (!config.proxyServer) {
    return null;
  }
  return {
    server: config.proxyServer,
    username: config.proxyUsername,
    password: config.proxyPassword,
  };
}

async function commandLogin(config, logger, values) {
  if (config.cookie) {
    const client = new VyceClient({ ...config, proxy: proxyFromConfig(config), logger });
    const user = await client.getMe();
    logger.info(`VYCE_COOKIE 有效，已登录：${describeUser(user)}`);
    return;
  }

  const result = await loginWithBrowser({
    baseUrl: config.baseUrl,
    statePath: config.statePath,
    headless: Boolean(values.headless),
    timeoutSeconds: config.loginTimeoutSeconds,
    proxy: proxyFromConfig(config),
    logger,
  });

  logger.info(`会话 Cookie 长度 ${result.cookie.length}。`);
  logger.info('提示：运行 "npm run export-cookie" 可打印 Cookie，用于 GitHub Actions Secret。');
}

async function tryBrowserCaptcha({ config, logger, summary, headless }) {
  if (!summary?.manual?.length || !config.captchaBrowser) {
    return null;
  }

  logger.info(
    `检测到 ${summary.manual.length} 台服务器需要 CAPTCHA，尝试用浏览器真实点击验证框（headless=${headless}）...`,
  );

  try {
    const uiSummary = await renewViaUi({
      baseUrl: config.baseUrl,
      statePath: config.statePath,
      cookie: config.cookie,
      headless,
      timeoutSeconds: config.captchaTimeoutSeconds,
      channel: config.browserChannel,
      headful: config.captchaHeadful,
      proxy: proxyFromConfig(config),
      logger,
    });
    summary.browserFallback = uiSummary;
    return uiSummary;
  } catch (error) {
    logger.warn(`浏览器自动验证失败：${describeError(error)}`);
    summary.browserFallbackError = error.message;
    return null;
  }
}

async function commandRenew(config, logger, values) {
  const dryRun = Boolean(values['dry-run']) || config.dryRun;
  const notifyConfig = values['no-notify'] ? { ...config, telegramNotify: false } : config;
  const headless = values.headed ? false : config.headless;

  if (values.ui) {
    if (dryRun) {
      throw new Error('--ui 与 --dry-run 不能同时使用。');
    }

    let summary;
    try {
      summary = await renewViaUi({
        baseUrl: config.baseUrl,
        statePath: config.statePath,
        cookie: config.cookie,
        headless,
        timeoutSeconds: config.captchaTimeoutSeconds,
        channel: config.browserChannel,
        headful: config.captchaHeadful,
        proxy: proxyFromConfig(config),
        logger,
      });
    } catch (error) {
      await notifyFailure({ config: notifyConfig, logger, error });
      throw error;
    }

    if (values.json) {
      process.stdout.write(`${toJson(summary)}\n`);
    }
    await notifyUiResult({ config: notifyConfig, logger, summary });
    if (summary.failed > 0 && !summary.captchaAttempted) {
      process.exitCode = 1;
    }
    return;
  }

  const client = new VyceClient({ ...config, proxy: proxyFromConfig(config), logger });
  let summary;
  try {
    summary = await runRenewal({
      client,
      logger,
      serverSelectors: config.serverSelectors,
      thresholdHours: config.thresholdHours,
      cooldownGraceMinutes: config.cooldownGraceMinutes,
      dryRun,
    });
  } catch (error) {
    await notifyFailure({ config: notifyConfig, logger, error });
    throw error;
  }

  // 如果 API 被 CAPTCHA 拦下，尝试用真实浏览器完成验证。
  const uiSummary = dryRun ? null : await tryBrowserCaptcha({ config, logger, summary, headless });
  const captchaSolved = (uiSummary?.succeeded ?? 0) > 0;

  if (values.json) {
    process.stdout.write(`${toJson(summary)}\n`);
  }

  if (captchaSolved) {
    await notifyUiResult({ config: notifyConfig, logger, summary: uiSummary });
  } else {
    if (uiSummary?.captchaAttempted) {
      logger.warn('浏览器未能通过 CAPTCHA，改为发送手动续期提醒。');
    }
    await notifyApiResult({ config: notifyConfig, logger, summary, dryRun });
  }

  if (
    summary.failed.length > 0 ||
    ((uiSummary?.failed ?? 0) > 0 && !uiSummary?.captchaAttempted && summary.manual.length === 0)
  ) {
    process.exitCode = 1;
  }
}

async function commandNotifyTest(config, logger, values) {
  const notifyConfig = values['no-notify'] ? { ...config, telegramNotify: false } : config;
  await notifyTest({ config: notifyConfig, logger });
}

async function commandStatus(config, logger, values) {
  const client = new VyceClient({ ...config, proxy: proxyFromConfig(config), logger });
  const user = await client.getMe();
  const allServers = await client.listServers();
  const servers = selectServers(allServers, config.serverSelectors);

  if (values.json) {
    process.stdout.write(
      `${toJson({
        user,
        servers: servers.map((server) => {
          const decision = computeRenewalDecision(server, Date.now(), { thresholdHours: config.thresholdHours });
          return { server, decision };
        }),
      })}\n`,
    );
    return;
  }

  logger.info(`账号：${describeUser(user)}`);
  logger.info(`服务器：${servers.length} 台${config.serverSelectors.length ? `（共 ${allServers.length} 台）` : ''}`);

  if (servers.length === 0) {
    logger.info('没有找到服务器。');
    return;
  }

  for (const server of servers) {
    const decision = computeRenewalDecision(server, Date.now(), { thresholdHours: config.thresholdHours });
    const status = `${server.status || 'unknown'}${server.suspended ? '（已暂停）' : ''}`;
    const plan = server.source === 'free' ? '免费' : '付费';
    let hint;
    if (decision.action === 'renew') {
      hint = decision.reason === 'stopped' ? '可续期并开机' : '现在可以续期';
    } else if (decision.reason === 'cooldown') {
      hint = `冷却中，${formatDuration(decision.cooldownMs)} 后可续期`;
    } else if (decision.reason === 'paid') {
      hint = '付费套餐，无需续期';
    } else {
      hint = '无需续期';
    }
    logger.info(
      `- ${server.name || '(未命名)'} [${server.id}] 状态=${status} 套餐=${plan} ` +
        `到期=${formatTimestamp(server.expiresAt)} 剩余=${decision.remainingMs === null ? '未知' : formatDuration(decision.remainingMs)} → ${hint}`,
    );
  }
}

async function commandExportCookie(config, logger) {
  const cookie = resolveCookieHeader({ cookie: config.cookie, statePath: config.statePath });
  if (!cookie) {
    throw new VyceAuthError(
      `没有找到可用的 Cookie。请先运行 "npm run login"（会话文件: ${config.statePath}）。`,
    );
  }

  const client = new VyceClient({ ...config, cookie, proxy: proxyFromConfig(config), logger });
  const user = await client.getMe();
  process.stderr.write(`[export-cookie] Cookie 有效，账号：${describeUser(user)}\n`);
  process.stderr.write('[export-cookie] 把下一行完整内容保存为 GitHub Actions Secret：VYCE_COOKIE\n');
  process.stdout.write(`${cookie}\n`);
}



async function commandDaemon(config, logger, values) {
  const intervalHours = values.interval ? Number(values.interval) : config.intervalHours;
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
    throw new Error(`--interval 的值无效：${values.interval}`);
  }
  const intervalMs = intervalHours * HOUR_MS;
  const client = new VyceClient({ ...config, proxy: proxyFromConfig(config), logger });
  const notifyConfig = values['no-notify'] ? { ...config, telegramNotify: false } : config;
  const headless = values.headed ? false : config.headless;

  let stopping = false;
  let wakeUp = null;

  const stop = (signal) => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info(`收到 ${signal}，正在停止...`);
    wakeUp?.();
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  const sleep = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  logger.info(`常驻模式启动：每 ${intervalHours} 小时检查一次（阈值 ${config.thresholdHours} 小时）。`);

  while (!stopping) {
    const startedAt = Date.now();
    let summary = null;

    try {
      summary = await runRenewal({
        client,
        logger,
        serverSelectors: config.serverSelectors,
        thresholdHours: config.thresholdHours,
        cooldownGraceMinutes: config.cooldownGraceMinutes,
        dryRun: config.dryRun,
      });

      const uiSummary = config.dryRun
        ? null
        : await tryBrowserCaptcha({ config, logger, summary, headless });
      if ((uiSummary?.succeeded ?? 0) > 0) {
        await notifyUiResult({ config: notifyConfig, logger, summary: uiSummary });
      } else {
        if (uiSummary?.captchaAttempted) {
          logger.warn('浏览器未能通过 CAPTCHA，改为发送手动续期提醒。');
        }
        await notifyApiResult({ config: notifyConfig, logger, summary, dryRun: config.dryRun });
      }
    } catch (error) {
      if (error instanceof VyceAuthError) {
        logger.error(`登录已失效：${error.message}`);
      } else {
        logger.error(`本轮续期失败：${describeError(error)}`);
      }
      await notifyFailure({ config: notifyConfig, logger, error });
    }

    if (values.once || stopping) {
      break;
    }

    let delayMs = intervalMs;
    if (summary?.nextDueAt && summary.nextDueAt > Date.now()) {
      const untilDue = summary.nextDueAt - Date.now() + 60_000;
      if (untilDue < delayMs) {
        delayMs = untilDue;
      }
    }

    const nextRun = new Date(Date.now() + delayMs);
    logger.info(
      `本轮耗时 ${formatDuration(Date.now() - startedAt)}，下次运行：${nextRun.toISOString().replace('T', ' ').replace('.000Z', ' UTC')}`,
    );
    await sleep(delayMs);
  }

  logger.info('已停止。');
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      ui: { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
      headless: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'no-notify': { type: 'boolean', default: false },
      once: { type: 'boolean', default: false },
      interval: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const command = positionals[0] || 'help';
  if (values.help || command === 'help') {
    process.stdout.write(HELP);
    return;
  }

  const config = loadConfig();
  const logger = createLogger({ level: values.json ? 'error' : 'info' });

  switch (command) {
    case 'login':
      await commandLogin(config, logger, values);
      break;
    case 'renew':
      await commandRenew(config, logger, values);
      break;
    case 'status':
      await commandStatus(config, logger, values);
      break;
    case 'daemon':
      await commandDaemon(config, logger, values);
      break;
    case 'export-cookie':
      await commandExportCookie(config, logger);
      break;
    case 'notify-test':
      await commandNotifyTest(config, logger, values);
      break;
    default:
      process.stderr.write(`未知命令：${command}\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((error) => {
  const logger = createLogger();
  if (error instanceof VyceAuthError) {
    logger.error(error.message);
    logger.error('修复方法：运行 "npm run login" 重新登录，并更新 VYCE_COOKIE / .auth/state.json。');
  } else {
    logger.error(describeError(error));
  }
  process.exitCode = 1;
});
