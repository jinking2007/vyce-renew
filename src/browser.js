import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseCookieString } from './cookies.js';
import { VyceAuthError, resolveCookieHeader } from './vyce-client.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureXvfb() {
  if (process.platform !== 'linux' || process.env.DISPLAY) {
    return null;
  }
  const display = ':99';
  const child = spawn('Xvfb', [display, '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], {
    stdio: 'ignore',
  });

  const started = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    child.once('error', () => finish(false));
    child.once('exit', () => finish(false));
    setTimeout(() => finish(true), 1200);
  });

  if (!started) {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    return null;
  }

  process.env.DISPLAY = display;
  return child;
}

function stopXvfb(child) {
  if (!child) {
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
  if (process.env.DISPLAY === ':99') {
    delete process.env.DISPLAY;
  }
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

async function launchBrowser({ headless = true, channel = '', proxy = null } = {}) {
  const { chromium } = await loadPlaywright();
  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
  ];
  const proxyOption =
    proxy?.server
      ? {
          server: proxy.server,
          ...(proxy.username ? { username: proxy.username } : {}),
          ...(proxy.password ? { password: proxy.password } : {}),
        }
      : null;
  // 优先用 Playwright 自带 Chromium；没安装时回退到系统 Chrome（GitHub Actions 自带）。
  const attempts = channel ? [{ channel }] : [{}, { channel: 'chrome' }];
  const errors = [];

  for (const attempt of attempts) {
    try {
      return await chromium.launch({
        headless,
        args,
        ...(proxyOption ? { proxy: proxyOption } : {}),
        ...attempt,
      });
    } catch (error) {
      errors.push(error);
    }
  }

  const firstLine = String(errors[0]?.message || errors[0] || 'unknown error').split('\n')[0];
  const missingLibs = errors.some((error) =>
    /shared libraries|error while loading shared libraries|cannot open shared object/i.test(String(error?.message || '')),
  );
  const hint = missingLibs
    ? '\n提示：当前系统缺少 Chromium 依赖库。请在有权限的 Linux 上执行 "npx playwright install --with-deps chromium"（需要 root/sudo）。'
    : '\n提示：可执行 "npx playwright install chromium" 安装浏览器，或设置 VYCE_BROWSER_CHANNEL=chrome 使用系统 Chrome。';
  throw new Error(`启动浏览器失败：${firstLine}${hint}`);
}

function desktopUserAgent(browser) {
  const version = String(browser?.version?.() || '131.0.0.0').split(' ')[0];
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
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
    userAgent: desktopUserAgent(browser),
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
export async function loginWithBrowser({
  baseUrl,
  statePath,
  headless = false,
  timeoutSeconds = 600,
  proxy = null,
  logger,
}) {
  const browser = await launchBrowser({ headless, proxy });
  const context = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    userAgent: desktopUserAgent(browser),
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

async function getBestcapToken(page) {
  return page
    .evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[name="bestcap-response"]'));
      const filled = inputs.find((input) => input.value && input.value.length > 5);
      return filled?.value || '';
    })
    .catch(() => '');
}

async function captchaModalVisible(page, timeout = 2000) {
  return page
    .getByText(/Complete the CAPTCHA verification/i)
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
}

function summarizeToken(token) {
  if (!token) {
    return { length: 0 };
  }
  const parts = token.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      return { length: token.length, jwtKeys: Object.keys(payload) };
    } catch {
      // ignore
    }
  }
  return { length: token.length };
}

/**
 * 真实点击 Bestcap 的 “I'm not a robot” 验证框。
 * 只模拟鼠标点击，不伪造 token，也不破解验证码。
 */
async function solveBestcap(
  page,
  { logger, timeoutSeconds = 60, detectTimeoutMs = 5000, humanDelayMs = 2500 } = {},
) {
  const iframe = page.locator('iframe[title="Bestcap human verification"]').first();
  const visible = await iframe
    .waitFor({ state: 'visible', timeout: detectTimeoutMs })
    .then(() => true)
    .catch(() => false);
  if (!visible) {
    return { encountered: false, solved: false };
  }

  logger?.info('检测到 Bestcap 验证框，正在模拟真实鼠标点击...');
  const frame = page.frameLocator('iframe[title="Bestcap human verification"]');
  const checkbox = frame.locator('#check, [role="checkbox"]').first();
  await checkbox.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

  if (!(await getBestcapToken(page))) {
    // 真人通常会先看一眼再点，等待一段时间能降低“点击过快”的风控概率。
    const pause = humanDelayMs + Math.random() * 1500;
    logger?.info(`等待 ${Math.round(pause)}ms 后点击验证框（模拟真人）...`);
    await sleep(pause);

    const box = await checkbox.boundingBox().catch(() => null);
    if (box) {
      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;
      await page.mouse.move(centerX - 120, centerY - 45, { steps: 18 }).catch(() => {});
      await sleep(250 + Math.random() * 350);
      await page.mouse.move(centerX, centerY, { steps: 14 }).catch(() => {});
      await sleep(120 + Math.random() * 180);
      await page.mouse.down();
      await sleep(80 + Math.random() * 120);
      await page.mouse.up();
    } else {
      await checkbox.click({ timeout: 15000, delay: 80 });
    }
  }

  const deadline = Date.now() + timeoutSeconds * 1000;
  let status = '';
  let firstCheck = true;

  while (Date.now() < deadline) {
    const token = await getBestcapToken(page);
    if (token) {
      logger?.info(`Bestcap token 已生成：${JSON.stringify(summarizeToken(token))}`);
      return { encountered: true, solved: true };
    }

    const verified = await frame
      .getByText('Verified', { exact: true })
      .first()
      .isVisible()
      .catch(() => false);
    if (verified) {
      await sleep(500);
      const verifiedToken = await getBestcapToken(page);
      if (verifiedToken) {
        logger?.info(`Bestcap token 已生成：${JSON.stringify(summarizeToken(verifiedToken))}`);
        return { encountered: true, solved: true };
      }
    }

    if (!firstCheck && !(await iframe.isVisible().catch(() => false))) {
      // 验证成功后弹窗通常会立即关闭，交给调用方用成功 toast 判断结果。
      logger?.info('Bestcap 弹窗已关闭，等待站点完成续期...');
      return { encountered: true, solved: true };
    }
    firstCheck = false;

    const statusText = ((await frame.locator('#status').textContent().catch(() => '')) || '').trim();
    if (statusText) {
      status = statusText;
    }
    if (/couldn't verify|try again|error|failed/i.test(status)) {
      return { encountered: true, solved: false, error: status };
    }

    await sleep(500);
  }

  return { encountered: true, solved: false, error: status || '验证超时' };
}

/**
 * 使用浏览器打开 https://vyce.cloud/#/servers 并点击 Renew 按钮。
 * 站点会先弹出一个赞助页面，脚本会自动关闭它并再次点击，真正完成续期。
 * 如果出现 Bestcap 验证框，会模拟真实鼠标点击完成验证。
 */
export async function renewViaUi({
  baseUrl,
  statePath,
  cookie = '',
  headless = true,
  timeoutSeconds = 60,
  channel = '',
  headful = false,
  proxy = null,
  logger,
}) {
  let xvfb = null;
  let browser = null;
  let context = null;
  let effectiveHeadless = headless;

  try {
    if (proxy?.server) {
      logger?.info(`浏览器使用代理：${proxy.server}`);
    }
    if (headful) {
      xvfb = await ensureXvfb();
      if (xvfb || process.platform !== 'linux') {
        effectiveHeadless = false;
        logger?.info('使用有头 Chrome（Xvfb 虚拟显示）以降低风控概率。');
      }
    }

    browser = await launchBrowser({ headless: effectiveHeadless, channel, proxy });
    context = await openContext(browser, { baseUrl, statePath, cookie });
    const page = await context.newPage();

    page.on('response', async (response) => {
      if (!/\/api\/servers\/[^/]+\/renew$/.test(response.url())) {
        return;
      }
      if (response.ok()) {
        logger?.info('续期接口返回成功。');
        return;
      }
      const body = await response.text().catch(() => '');
      logger?.warn(`续期接口返回 HTTP ${response.status()}：${body.slice(0, 500)}`);
    });

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

    const summary = {
      clicked: 0,
      succeeded: 0,
      failed: 0,
      messages: [],
      captchaAttempted: false,
      captchaSolved: false,
    };
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
          const adViewMs = 4000 + Math.random() * 3000;
          logger?.info(`站点打开了一个赞助页面，停留 ${Math.round(adViewMs)}ms 后关闭（模拟真人）...`);
          await sleep(adViewMs);
          await popup.close().catch(() => {});
          await page.bringToFront();
        }

        // 新流程：第一次点击就会弹出 CAPTCHA 弹窗；旧流程需要第二次点击。
        let modalVisible = await captchaModalVisible(page, popup ? 5000 : 2000);

        if (!modalVisible) {
          logger?.info('未检测到验证弹窗，按旧流程再次点击 Renew...');
          try {
            await target.click({ timeout: 10000 });
          } catch (error) {
            logger?.warn(
              `再次点击 Renew 未成功（可能弹窗已打开）：${String(error?.message || error).split('\n')[0]}`,
            );
          }
          modalVisible = await captchaModalVisible(page, 5000);
        }

        // 站点新增了 Bestcap 人机验证：模拟真实鼠标点击验证框，不伪造 token。
        const captcha = await solveBestcap(page, {
          logger,
          timeoutSeconds,
          detectTimeoutMs: modalVisible ? 15000 : 5000,
        });
        if (captcha.encountered) {
          summary.captchaAttempted = true;
          if (!captcha.solved) {
            summary.failed += 1;
            summary.messages.push(`CAPTCHA 自动验证未通过：${captcha.error || '未知原因'}`);
            logger?.warn(`Bestcap 验证未通过：${captcha.error || '未知原因'}，需要手动完成。`);
            break;
          }
          summary.captchaSolved = true;
          logger?.info('验证已通过，等待站点完成续期...');
        }

        const toast = page.locator('[data-sonner-toast]').first();
        await toast.waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});
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
    await browser?.close().catch(() => {});
    stopXvfb(xvfb);
  }
}
