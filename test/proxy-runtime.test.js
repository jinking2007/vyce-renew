import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrowserProfile, resolveProxyRuntime } from '../src/proxy-runtime.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

test('buildBrowserProfile 优先使用 IP 城市时区', () => {
  assert.deepEqual(buildBrowserProfile({ country: 'US', timezoneId: 'America/Los_Angeles' }), {
    timezoneId: 'America/Los_Angeles',
    locale: 'en-US',
  });
});

test('buildBrowserProfile 缺少城市时区时回退国家默认值', () => {
  assert.deepEqual(buildBrowserProfile({ country: 'AU' }), {
    timezoneId: 'Australia/Sydney',
    locale: 'en-AU',
  });
});

test('buildBrowserProfile 未知国家且无时区时返回 null', () => {
  assert.equal(buildBrowserProfile({ country: 'ZZ' }), null);
  assert.equal(buildBrowserProfile({}), null);
});

test('resolveProxyRuntime 未配置代理时返回空', async () => {
  const runtime = await resolveProxyRuntime({}, silentLogger, { probe: false });
  assert.equal(runtime.proxy, null);
  assert.equal(runtime.kind, 'none');
  await runtime.stop();
});

test('resolveProxyRuntime 支持 HTTP 代理', async () => {
  const runtime = await resolveProxyRuntime(
    {
      proxyUrl: 'http://127.0.0.1:7890',
      proxyUsername: 'user',
      proxyPassword: 'pass',
    },
    silentLogger,
    { probe: false },
  );
  assert.deepEqual(runtime.proxy, {
    server: 'http://127.0.0.1:7890',
    username: 'user',
    password: 'pass',
  });
  assert.equal(runtime.kind, 'direct-proxy');
  await runtime.stop();
});

test('resolveProxyRuntime 对缺 pbk 的 VLESS 在下载前就报错', async () => {
  await assert.rejects(
    () =>
      resolveProxyRuntime(
        {
          proxyUrl: 'vless://uuid@example.com:443?security=reality&type=tcp',
          singBoxPath: '/nonexistent/sing-box',
        },
        silentLogger,
        { probe: false },
      ),
    /pbk/,
  );
});
