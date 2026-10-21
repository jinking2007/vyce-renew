import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOUR_MS } from '../src/decisions.js';

const CLI = path.resolve('src/cli.js');

async function listenNode(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function startMocks() {
  const servers = [
    { id: 'due1', name: 'tokyo-mini', source: 'free', status: 'running', expiresAt: Date.now() + 3 * HOUR_MS },
  ];
  const telegramCalls = [];

  const vyce = await listenNode((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };

    if (url.pathname === '/api/me') {
      return send(200, { user: { id: 7, githubId: 99, login: 'demo-user' } });
    }
    if (url.pathname === '/api/servers' && request.method === 'GET') {
      return send(200, { servers });
    }
    if (url.pathname === '/api/servers/due1/renew' && request.method === 'POST') {
      servers[0].expiresAt += 48 * HOUR_MS;
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/servers/due1' && request.method === 'GET') {
      return send(200, { server: servers[0] });
    }
    return send(404, { error: 'not_found', message: 'Not found.' });
  });

  const telegram = await listenNode((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      telegramCalls.push({ url: request.url, body: raw ? JSON.parse(raw) : {} });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });

  return {
    vyceUrl: `http://127.0.0.1:${vyce.port}`,
    telegramUrl: `http://127.0.0.1:${telegram.port}`,
    telegramCalls,
    close: async () => {
      await new Promise((resolve) => vyce.server.close(resolve));
      await new Promise((resolve) => telegram.server.close(resolve));
    },
  };
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        VYCE_BASE_URL: env.vyceUrl,
        VYCE_COOKIE: 'vyce_session=test-cookie',
        VYCE_STATE_PATH: path.join('/tmp', 'vyce-renew-missing-state.json'),
        TELEGRAM_BOT_TOKEN: '123:TEST',
        TELEGRAM_CHAT_ID: '999',
        TELEGRAM_API_BASE: env.telegramUrl,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI renew：续期成功后发送 Telegram 通知', async () => {
  const mocks = await startMocks();
  try {
    const result = await runCli(['renew'], mocks);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /续期成功/);
    assert.equal(mocks.telegramCalls.length, 1);
    assert.match(mocks.telegramCalls[0].body.text, /tokyo-mini/);
    assert.equal(mocks.telegramCalls[0].body.chat_id, '999');
  } finally {
    await mocks.close();
  }
});

test('CLI renew --no-notify：不发送通知', async () => {
  const mocks = await startMocks();
  try {
    const result = await runCli(['renew', '--no-notify'], mocks);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mocks.telegramCalls.length, 0);
  } finally {
    await mocks.close();
  }
});

test('CLI notify-test：发送测试消息', async () => {
  const mocks = await startMocks();
  try {
    const result = await runCli(['notify-test'], mocks);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mocks.telegramCalls.length, 1);
    assert.match(mocks.telegramCalls[0].body.text, /通知测试/);
  } finally {
    await mocks.close();
  }
});
