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
  });
  assert.equal(config.baseUrl, 'https://example.test');
  assert.equal(config.cookie, 'a=1');
  assert.deepEqual(config.serverSelectors, ['srv-1', 'My VPS']);
  assert.equal(config.thresholdHours, 12);
  assert.equal(config.intervalHours, 6);
  assert.equal(config.dryRun, true);
  assert.equal(config.headless, false);
});

test('loadConfig 对非法数字和布尔值抛出错误', () => {
  assert.throws(() => loadConfig({ VYCE_THRESHOLD_HOURS: 'abc' }), /VYCE_THRESHOLD_HOURS/);
  assert.throws(() => loadConfig({ VYCE_THRESHOLD_HOURS: '25' }), /VYCE_THRESHOLD_HOURS/);
  assert.throws(() => loadConfig({ VYCE_DRY_RUN: 'maybe' }), /VYCE_DRY_RUN/);
});
