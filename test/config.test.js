import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

test('loadConfig 提供合理默认值', () => {
  const config = loadConfig({});
  assert.equal(config.baseUrl, 'https://vyce.cloud');
  assert.equal(config.cookie, '');
  assert.equal(config.thresholdHours, 24);
  assert.equal(config.intervalHours, 24);
  assert.equal(config.dryRun, false);
  assert.equal(config.headless, true);
  assert.equal(config.loginTimeoutSeconds, 600);
  assert.equal(config.timeoutMs, 20000);
  assert.deepEqual(config.serverSelectors, []);
  assert.equal(path.basename(config.statePath), 'state.json');
  assert.equal(config.telegramBotToken, '');
  assert.equal(config.telegramChatId, '');
  assert.equal(config.telegramApiBase, 'https://api.telegram.org');
  assert.equal(config.telegramNotify, true);
  assert.equal(config.telegramNotifyAlways, false);
  assert.equal(config.cooldownGraceMinutes, 5);
  assert.equal(config.captchaBrowser, true);
  assert.equal(config.captchaTimeoutSeconds, 60);
  assert.equal(config.browserChannel, '');
});

test('loadConfig 读取环境变量并去掉末尾斜杠', () => {
  const config = loadConfig({
    VYCE_BASE_URL: 'https://example.test/',
    VYCE_COOKIE: 'a=1',
    VYCE_SERVERS: 'srv-1, My VPS ,,',
    VYCE_THRESHOLD_HOURS: '12',
    VYCE_INTERVAL_HOURS: '6',
    VYCE_DRY_RUN: 'yes',
    VYCE_HEADLESS: '0',
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_CHAT_ID: '42',
    TELEGRAM_API_BASE: 'http://127.0.0.1:8080/',
    TELEGRAM_NOTIFY: 'always',
    VYCE_COOLDOWN_GRACE_MINUTES: '2',
    VYCE_CAPTCHA_BROWSER: 'false',
    VYCE_CAPTCHA_TIMEOUT_SECONDS: '120',
    VYCE_BROWSER_CHANNEL: 'chrome',
  });
  assert.equal(config.baseUrl, 'https://example.test');
  assert.equal(config.cookie, 'a=1');
  assert.deepEqual(config.serverSelectors, ['srv-1', 'My VPS']);
  assert.equal(config.thresholdHours, 12);
  assert.equal(config.intervalHours, 6);
  assert.equal(config.dryRun, true);
  assert.equal(config.headless, false);
  assert.equal(config.telegramBotToken, '123:abc');
  assert.equal(config.telegramChatId, '42');
  assert.equal(config.telegramApiBase, 'http://127.0.0.1:8080');
  assert.equal(config.telegramNotify, true);
  assert.equal(config.telegramNotifyAlways, true);
  assert.equal(config.cooldownGraceMinutes, 2);
  assert.equal(config.captchaBrowser, false);
  assert.equal(config.captchaTimeoutSeconds, 120);
  assert.equal(config.browserChannel, 'chrome');
});

test('TELEGRAM_NOTIFY=false 关闭通知，always 作为每日心跳', () => {
  const off = loadConfig({ TELEGRAM_NOTIFY: 'false' });
  assert.equal(off.telegramNotify, false);
  assert.equal(off.telegramNotifyAlways, false);

  const always = loadConfig({ TELEGRAM_NOTIFY: 'always' });
  assert.equal(always.telegramNotify, true);
  assert.equal(always.telegramNotifyAlways, true);
});

test('loadConfig 对非法数字和布尔值抛出错误', () => {
  assert.throws(() => loadConfig({ VYCE_THRESHOLD_HOURS: 'abc' }), /VYCE_THRESHOLD_HOURS/);
  assert.throws(() => loadConfig({ VYCE_THRESHOLD_HOURS: '25' }), /VYCE_THRESHOLD_HOURS/);
  assert.throws(() => loadConfig({ VYCE_DRY_RUN: 'maybe' }), /VYCE_DRY_RUN/);
});
