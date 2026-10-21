import fs from 'node:fs';
import path from 'node:path';
import { parseCookieString } from './cookies.js';
import { VyceAuthError, resolveCookieHeader } from './vyce-client.js';

const AD_HOSTS = /(^|\.)(uplcm\.com|n6wxm\.com|nap5k\.com)$/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    throw new Error(
      `无法加载 playwright，请先在项目目录运行 "npm install"（${error?.message || error}）。`,
    );
  }
}

async function launchBrowser({ headless = true } = {}) {
  const { chromium } = await loadPlaywright();
  try {
    return await chromium.launch({
      headless,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (error) {
    const firstLine = String(error?.message || error).split('\n')[0];
    const missingLibs = /shared libraries|error while loading shared libraries|cannot open shared object/i.test(
      String(error?.message || ''),
    );
    const hint = missingLibs
      ? '\n提示：当前系统缺少 Chromium 依赖库。请在有权限的 Linux 上执行 "npx playwright install --with-deps chromium"（需要 root/sudo），或改用 API 模式 "npm run renew"。'
      : '';
    throw new Error(`启动 Chromium 失败：${firstLine}${hint}`);
  }
}

function cookieObjects(cookieString) {
  return parseCookieString(cookieString).map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: 'vyce.cloud',
    path: '/',
    secure: true,
    sameSite: 'Lax',
  }));
}

async function openContext(browser, { baseUrl, statePath, cookie }) {
  const hasState = Boolean(statePath) && fs.existsSync(statePath);
  const context = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    ...(hasState ? { storageState: statePath } : {}),
  });

  if (!hasState) {
    const cookies = cookieObjects(cookie);
    if (cookies.length === 0) {
      await context.close();
      throw new VyceAuthError(
        `没有找到登录会话。请先运行 "npm run login"，或设置 VYCE_COOKIE 环境变量（会话文件: ${statePath || '未配置'}）。`,
      );
    }
    await context.addCookies(cookies);
  }

  await context.route('**/*', (route) => {
    try {
      const host = new URL(route.request().url()).hostname;
      if (AD_HOSTS.test(host)) {
        return route.abort();
      }
    } catch {
      // 忽略无法解析的 URL
    }
    return route.continue();
  });

  return context;
}
async function saveStorageState(context, statePath, logger) {
  if (!statePath) {
    return;
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  await context.storageState({ path: statePath });
  try {
    fs.chmodSync(statePath, 0o600);
  } catch {
    // Windows 等平台可能不支持 chmod，忽略。
  }
  logger?.info(`登录会话已保存到 ${statePath}`);
}



/**
 * 打开浏览器让用户用 GitHub 登录一次，登录成功后把 Cookie 保存为 storageState。
 */
export async function loginWithBrowser({ baseUrl, statePath, headless = false, timeoutSeconds = 600, logger }) {
  const browser = await launchBrowser({ headless });
  const context = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });

  try {
    const page = await context.newPage();
    await page.goto('/#/servers', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    logger?.info('浏览器已打开。请在页面中点击 “Continue with GitHub” 完成登录（如启用了两步验证，也需要在页面里完成）。');
    logger?.info(`等待登录，最长 ${Math.round(timeoutSeconds / 60)} 分钟...`);

    const deadline = Date.now() + timeoutSeconds * 1000;
    let user = null;
    let lastError = '';

    while (Date.now() < deadline) {
      if (page.isClosed()) {
        throw new Error('登录窗口在完成登录前被关闭。');
      }
      try {
        const response = await context.request.get('/api/me', {
          headers: { accept: 'application/json' },
          timeout: 15000,
        });
        if (response.ok()) {
          const data = await response.json();
          if (data?.user && !data.user.mfaPending) {
            user = data.user;
            break;
          }
          lastError = data?.user?.mfaPending ? '等待两步验证码...' : '';
        }
      } catch (error) {
        lastError = error?.message || String(error);
      }
      await sleep(3000);
    }

    if (!user) {
      throw new Error(`等待登录超时${lastError ? `（${lastError}）` : ''}，请重新运行 "npm run login"。`);
    }

    await saveStorageState(context, statePath, logger);
    const cookie = resolveCookieHeader({ statePath });
    if (!cookie) {
      throw new Error('登录成功，但没有捕获到会话 Cookie，请重试或在浏览器中手动复制 Cookie。');
    }

    logger?.info(`登录成功：${user.login || user.name || user.id}`);
    return { user, cookie };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * 使用浏览器打开 https://vyce.cloud/#/servers 并点击 Renew 按钮。
 * 站点会先弹出一个赞助页面，脚本会自动关闭它并再次点击，真正完成续期。
 */
export async function renewViaUi({ baseUrl, statePath, cookie = '', headless = true, logger }) {
  const browser = await launchBrowser({ headless });
  let context;
  try {
    context = await openContext(browser, { baseUrl, statePath, cookie });
    const page = await context.newPage();
    await page.goto('/#/servers', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page
      .locator('button', { hasText: /Continue with GitHub|Renew/ })
      .first()
      .waitFor({ state: 'visible', timeout: 30000 })
      .catch(() => {});
    await page.waitForTimeout(2000);

    const loginButton = page.getByRole('button', { name: /Continue with GitHub/i });
    if (await loginButton.isVisible().catch(() => false)) {
      throw new VyceAuthError('页面要求重新登录，浏览器会话已失效。请重新运行 "npm run login"。');
    }

    const summary = { clicked: 0, succeeded: 0, failed: 0, messages: [] };
    const renewButtons = page.getByRole('button', { name: /^(Renew|Renew and start)$/ });

    for (let round = 0; round < 30; round += 1) {
      const count = await renewButtons.count();
      let target = null;

      for (let index = 0; index < count; index += 1) {
        const candidate = renewButtons.nth(index);
        if (
          (await candidate.isVisible().catch(() => false)) &&
          (await candidate.isEnabled().catch(() => false))
        ) {
          target = candidate;
          break;
        }
      }

      if (!target) {
        break;
      }

      const buttonText = ((await target.textContent().catch(() => '')) || 'Renew').trim();
      summary.clicked += 1;
      logger?.info(`点击第 ${summary.clicked} 个 “${buttonText}” 按钮...`);

      try {
        const popupPromise = context.waitForEvent('page', { timeout: 2500 }).catch(() => null);
        await target.click({ timeout: 15000 });
        const popup = await popupPromise;

        if (popup) {
          logger?.info('站点打开了一个赞助页面，正在关闭并按站点要求再次点击 Renew...');
          await popup.close().catch(() => {});
          await page.bringToFront();
          await target.click({ timeout: 15000 });
        }

        const toast = page.locator('[data-sonner-toast]').first();
        await toast.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
        const toastText = ((await toast.textContent().catch(() => '')) || '').trim();

        if (/Renewed/i.test(toastText)) {
          summary.succeeded += 1;
          summary.messages.push(toastText);
          logger?.info(`✅ ${toastText}`);
        } else if (toastText) {
          summary.failed += 1;
          summary.messages.push(toastText);
          logger?.warn(`续期未成功：${toastText}`);
        } else {
          summary.failed += 1;
          summary.messages.push('未检测到续期结果提示');
          logger?.warn('未检测到续期结果提示，请检查页面状态。');
        }
      } catch (error) {
        summary.failed += 1;
        summary.messages.push(error?.message || String(error));
        logger?.error(`点击 Renew 失败：${error?.message || error}`);
      }
    }

    if (summary.clicked === 0) {
      logger?.info('页面上没有可点击的 Renew 按钮（可能都在冷却中，或账号下没有免费服务器）。');
    }

    await saveStorageState(context, statePath, logger).catch(() => {});
    return summary;
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
