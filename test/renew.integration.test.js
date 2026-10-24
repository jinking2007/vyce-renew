import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HOUR_MS } from '../src/decisions.js';
import { VyceAuthError, VyceClient } from '../src/vyce-client.js';
import { runRenewal } from '../src/renew.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function startMockServer({ servers, meStatus = 200, renewFailures = new Set(), captchaServers = new Set() } = {}) {
  const state = {
    servers: structuredClone(servers),
    seenCookies: [],
    seenOrigins: [],
    renewCalls: [],
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const reply = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };

    state.seenCookies.push(request.headers.cookie || '');
    state.seenOrigins.push(request.headers.origin || '');

    if (url.pathname === '/api/me') {
      if (meStatus !== 200) {
        return reply(meStatus, { error: 'unauthenticated', message: 'Please sign in.' });
      }
      return reply(200, { user: { id: 1, githubId: 42, login: 'tester' } });
    }

    if (url.pathname === '/api/servers' && request.method === 'GET') {
      return reply(200, { servers: state.servers });
    }

    const renewMatch = url.pathname.match(/^\/api\/servers\/([^/]+)\/renew$/);
    if (renewMatch && request.method === 'POST') {
      const id = decodeURIComponent(renewMatch[1]);
      state.renewCalls.push(id);
      if (renewFailures.has(id)) {
        return reply(400, { error: 'renewal_failed', message: 'Renewal failed for test.' });
      }
      if (captchaServers.has(id)) {
        return reply(400, {
          error: 'captcha_required',
          message: 'Please complete the CAPTCHA verification first.',
        });
      }
      const target = state.servers.find((server) => server.id === id);
      if (!target) {
        return reply(404, { error: 'not_found', message: 'Server not found.' });
      }
      target.expiresAt = (target.expiresAt ?? Date.now()) + 48 * HOUR_MS;
      target.status = 'running';
      return reply(200, { ok: true });
    }

    const detailMatch = url.pathname.match(/^\/api\/servers\/([^/]+)$/);
    if (detailMatch && request.method === 'GET') {
      const target = state.servers.find((server) => server.id === decodeURIComponent(detailMatch[1]));
      if (!target) {
        return reply(404, { error: 'not_found', message: 'Server not found.' });
      }
      return reply(200, { server: target });
    }

    return reply(404, { error: 'not_found', message: 'Not found.' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function makeClient(baseUrl, cookie = 'vyce_session=test-cookie') {
  return new VyceClient({ baseUrl, cookie, timeoutMs: 5000, retries: 0, logger: silentLogger });
}

test('runRenewal：只续期到期的免费服务器，并返回新的到期时间', async () => {
  const now = Date.now();
  const mock = await startMockServer({
    servers: [
      { id: 'due', name: 'due-server', source: 'free', status: 'running', expiresAt: now + 2 * HOUR_MS },
      { id: 'cool', name: 'cool-server', source: 'free', status: 'running', expiresAt: now + 40 * HOUR_MS },
      { id: 'paid', name: 'paid-server', source: 'paid', status: 'running', expiresAt: now + HOUR_MS },
    ],
  });

  try {
    const summary = await runRenewal({
      client: makeClient(mock.baseUrl),
      logger: silentLogger,
      thresholdHours: 24,
    });

    assert.equal(summary.checked, 3);
    assert.equal(summary.renewed.length, 1);
    assert.equal(summary.renewed[0].server.id, 'due');
    assert.equal(summary.skipped.length, 2);
    assert.deepEqual(mock.state.renewCalls, ['due']);
    assert.ok(summary.renewed[0].expiresAt > now + 2 * HOUR_MS);
    assert.ok(summary.nextDueAt > now + 15 * HOUR_MS);
    assert.ok(mock.state.seenCookies.every((cookie) => cookie === 'vyce_session=test-cookie'));
    // 站点会校验 POST 的 Origin，缺少时返回 403 bad_origin。
    assert.ok(mock.state.seenOrigins.every((origin) => origin === mock.baseUrl));
  } finally {
    await mock.close();
  }
});

test('runRenewal：dry-run 不调用续期接口', async () => {
  const now = Date.now();
  const mock = await startMockServer({
    servers: [
      { id: 'due', name: 'due-server', source: 'free', status: 'running', expiresAt: now + 2 * HOUR_MS },
    ],
  });

  try {
    const summary = await runRenewal({
      client: makeClient(mock.baseUrl),
      logger: silentLogger,
      thresholdHours: 24,
      dryRun: true,
    });

    assert.equal(summary.planned.length, 1);
    assert.equal(summary.renewed.length, 0);
    assert.deepEqual(mock.state.renewCalls, []);
  } finally {
    await mock.close();
  }
});

test('runRenewal：单台续期失败会记录到 failed，不影响其他服务器', async () => {
  const now = Date.now();
  const mock = await startMockServer({
    servers: [
      { id: 'bad', name: 'bad-server', source: 'free', status: 'running', expiresAt: now + HOUR_MS },
      { id: 'good', name: 'good-server', source: 'free', status: 'running', expiresAt: now + 2 * HOUR_MS },
    ],
    renewFailures: new Set(['bad']),
  });

  try {
    const summary = await runRenewal({
      client: makeClient(mock.baseUrl),
      logger: silentLogger,
      thresholdHours: 24,
    });

    assert.equal(summary.failed.length, 1);
    assert.equal(summary.failed[0].server.id, 'bad');
    assert.equal(summary.renewed.length, 1);
    assert.equal(summary.renewed[0].server.id, 'good');
    assert.deepEqual(mock.state.renewCalls.sort(), ['bad', 'good']);
  } finally {
    await mock.close();
  }
});

test('runRenewal：CAPTCHA 错误归类为 manual，而不是普通失败', async () => {
  const now = Date.now();
  const mock = await startMockServer({
    servers: [
      { id: 'cap', name: 'captcha-server', source: 'free', status: 'running', expiresAt: now + HOUR_MS },
    ],
    captchaServers: new Set(['cap']),
  });

  try {
    const summary = await runRenewal({
      client: makeClient(mock.baseUrl),
      logger: silentLogger,
      thresholdHours: 24,
    });
    assert.equal(summary.manual.length, 1);
    assert.equal(summary.manual[0].server.id, 'cap');
    assert.equal(summary.failed.length, 0);
    assert.deepEqual(mock.state.renewCalls, ['cap']);
  } finally {
    await mock.close();
  }
});

test('runRenewal：距续期窗口只差几秒时会等待并自动续期', async () => {
  const now = Date.now();
  const mock = await startMockServer({
    servers: [
      {
        id: 'edge',
        name: 'edge-server',
        source: 'free',
        status: 'running',
        expiresAt: now + 24 * HOUR_MS + 200,
      },
    ],
  });

  try {
    const summary = await runRenewal({
      client: makeClient(mock.baseUrl),
      logger: silentLogger,
      thresholdHours: 24,
      cooldownGraceMinutes: 0.1,
    });
    assert.equal(summary.renewed.length, 1);
    assert.deepEqual(mock.state.renewCalls, ['edge']);
  } finally {
    await mock.close();
  }
});

test('VyceClient：401 会抛出 VyceAuthError', async () => {
  const mock = await startMockServer({ servers: [], meStatus: 401 });
  try {
    const client = makeClient(mock.baseUrl);
    await assert.rejects(() => runRenewal({ client, logger: silentLogger }), VyceAuthError);
  } finally {
    await mock.close();
  }
});

test('VyceClient：没有 Cookie 时抛出 VyceAuthError', async () => {
  const client = new VyceClient({ baseUrl: 'https://vyce.cloud', cookie: '', statePath: '/nonexistent/state.json' });
  await assert.rejects(() => client.getMe(), VyceAuthError);
});
