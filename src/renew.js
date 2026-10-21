import {
  computeRenewalDecision,
  formatDuration,
  formatTimestamp,
  selectServers,
} from './decisions.js';
import { VyceAuthError } from './vyce-client.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serverLabel(server) {
  const name = server?.name || '(未命名)';
  return server?.id ? `${name} [${server.id}]` : name;
}

function describeSkip(decision) {
  switch (decision.reason) {
    case 'cooldown':
      return `冷却中：剩余 ${formatDuration(decision.remainingMs)}，约 ${formatDuration(decision.cooldownMs)} 后可续期`;
    case 'paid':
      return '非免费套餐，无需续期';
    case 'suspended':
      return '服务器已被暂停，无法续期';
    case 'creating':
      return '服务器创建中，跳过';
    case 'no-expiry':
      return '没有到期时间，跳过';
    default:
      return `跳过（${decision.reason}）`;
  }
}

/**
 * 登录并续期所有到期的免费服务器。
 * 返回结构化结果，方便 daemon / CLI 汇报。
 */
export async function runRenewal({
  client,
  logger,
  serverSelectors = [],
  thresholdHours = 24,
  cooldownGraceMinutes = 5,
  dryRun = false,
}) {
  const user = await client.getMe();
  logger.info(`已登录：${user.login || user.name || user.id}（GitHub ID: ${user.githubId ?? user.id}）`);

  const allServers = await client.listServers();
  const servers = selectServers(allServers, serverSelectors);

  if (serverSelectors.length > 0 && servers.length === 0) {
    logger.warn(`没有找到匹配 VYCE_SERVERS 的服务器：${serverSelectors.join(', ')}（账号下共有 ${allServers.length} 台）`);
  } else {
    logger.info(`账号下共 ${allServers.length} 台服务器，本次检查 ${servers.length} 台。`);
  }

  const summary = {
    user,
    checked: servers.length,
    renewed: [],
    planned: [],
    skipped: [],
    failed: [],
    nextDueAt: null,
  };

  for (const server of servers) {
    let decision = computeRenewalDecision(server, Date.now(), { thresholdHours });
    const label = serverLabel(server);

    // 每天固定时刻运行时，可能比上一次续期完成时间早几秒，导致剩余时间略大于 24 小时。
    // 若只差很短时间就进入续期窗口，则等待后重试，避免白白跳过一个周期。
    const graceMs = Math.max(0, cooldownGraceMinutes) * 60 * 1000;
    if (
      decision.action === 'skip' &&
      decision.reason === 'cooldown' &&
      graceMs > 0 &&
      decision.cooldownMs <= graceMs
    ) {
      const waitMs = decision.cooldownMs + 2000;
      logger.info(
        `${label}：距续期窗口还有 ${formatDuration(decision.cooldownMs)}，等待 ${formatDuration(waitMs)} 后重试...`,
      );
      await sleep(waitMs);
      decision = computeRenewalDecision(server, Date.now(), { thresholdHours });
    }

    if (decision.action === 'skip') {
      logger.info(`${label}：${describeSkip(decision)}`);
      summary.skipped.push({ server, decision });

      if (decision.reason === 'cooldown') {
        const dueAt = decision.expiresAt - thresholdHours * 60 * 60 * 1000;
        summary.nextDueAt = summary.nextDueAt === null ? dueAt : Math.min(summary.nextDueAt, dueAt);
      }
      continue;
    }

    const deadlineText = formatTimestamp(decision.expiresAt);
    if (dryRun) {
      logger.info(`${label}：${dryRunText(decision)}（到期 ${deadlineText}），试运行不执行。`);
      summary.planned.push({ server, decision });
      continue;
    }

    logger.info(`${label}：${dryRunText(decision)}（到期 ${deadlineText}），正在续期...`);
    try {
      await client.renewServer(server.id);
    } catch (error) {
      if (error instanceof VyceAuthError) {
        throw error;
      }
      logger.error(`${label}：续期失败 - ${error.message}${error.code ? ` (${error.code})` : ''}`);
      summary.failed.push({ server, error });
      continue;
    }

    let updated = null;
    try {
      updated = await client.getServer(server.id);
    } catch (error) {
      logger.warn(`${label}：续期请求已成功，但读取最新状态失败：${error.message}`);
    }

    const previousExpiresAt = decision.expiresAt;
    const newExpiresAt = updated?.expiresAt ?? null;
    if (newExpiresAt !== null && previousExpiresAt !== null && newExpiresAt <= previousExpiresAt) {
      logger.warn(`${label}：接口返回成功，但到期时间没有变化（${formatTimestamp(newExpiresAt)}）。`);
    }

    logger.info(
      `${label}：✅ 续期成功，到期时间 ${formatTimestamp(previousExpiresAt)} → ${formatTimestamp(newExpiresAt)}` +
        `${updated?.status ? `，状态 ${updated.status}` : ''}`,
    );
    summary.renewed.push({ server, previousExpiresAt, expiresAt: newExpiresAt, status: updated?.status ?? null });
  }

  if (summary.renewed.length === 0 && summary.planned.length === 0 && summary.failed.length === 0) {
    logger.info('本次没有需要续期的服务器。');
  }

  logger.info(
    `本次结果：续期 ${summary.renewed.length} 台，计划 ${summary.planned.length} 台，跳过 ${summary.skipped.length} 台，失败 ${summary.failed.length} 台。`,
  );

  return summary;
}

function dryRunText(decision) {
  if (decision.reason === 'stopped') {
    return '已关机，将续期并开机';
  }
  if (decision.reason === 'late') {
    return '已超过到期时间，立即续期';
  }
  return `已进入续期窗口（剩余 ${formatDuration(decision.remainingMs)}），立即续期`;
}
