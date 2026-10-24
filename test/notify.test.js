import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  buildApiMessage,
  buildFailureMessage,
  buildUiMessage,
  notifyApiResult,
  notifyFailure,
  notifyTest,
  sendTelegramMessage,
} from '../src/notify.js';
import { VyceAuthError } from '../src/vyce-client.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function startTelegramMock({ ok = true, description = 'Bad Request' } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      requests.push({
        url: request.url,
        contentType: request.headers['content-type'],
        body: raw ? JSON.parse(raw) : {},
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(ok ? { ok: true, result: { message_id: 1 } } : { ok: false, description }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    apiBase: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function makeConfig(apiBase) {
  return {
    baseUrl: 'https://vyce.cloud',
    telegramBotToken: '123456:TEST-TOKEN',
    telegramChatId: '987654321',
    telegramApiBase: apiBase,
    telegramNotify: true,
    timeoutMs: 5000,
  };
}

const sampleSummary = {
  user: { login: 'tester' },
  renewed: [
    {
      server: { id: 'srv-1', name: 'tokyo-mini' },
      previousExpiresAt: Date.parse('2026-01-01T00:00:00Z'),
      expiresAt: Date.parse('2026-01-03T00:00:00Z'),
    },
  ],
  planned: [],
  skipped: [{ server: { id: 'srv-2', name: 'us-mini' }, decision: { reason: 'cooldown' } }],
  failed: [],
};

test('buildApiMessage 包含续期结果、冷却数量和链接，并转义 HTML', () => {
  const summary = {
    ...sampleSummary,
    user: { login: '<script>alert(1)</script>' },
    failed: [{ server: { id: 'bad', name: 'bad&vps' }, error: { message: 'boom <x>' } }],
  };
  const text = buildApiMessage(summary);
  assert.match(text, /vyce\.cloud 自动续期/);
  assert.match(text, /续期成功：1 台/);
  assert.match(text, /tokyo-mini/);
  assert.match(text, /失败：1 台/);
  assert.match(text, /bad&amp;vps/);
  assert.match(text, /冷却中 1 台/);
  assert.match(text, /https:\/\/vyce\.cloud\/#\/servers/);
  assert.ok(!text.includes('<script>'));
  assert.ok(!text.includes('boom <x>'));
  assert.match(text, /&lt;script&gt;/);
});

test('buildApiMessage 试运行显示计划', () => {
  const text = buildApiMessage(
    {
      user: { login: 'tester' },
      renewed: [],
      planned: [{ server: { id: 'srv-1', name: 'tokyo-mini' }, decision: { expiresAt: Date.now() + 1000 } }],
      skipped: [],
      failed: [],
    },
    { dryRun: true },
  );
  assert.match(text, /续期预检/);
  assert.match(text, /计划续期：1 台/);
});

test('buildUiMessage 汇总浏览器点击结果', () => {
  const text = buildUiMessage({ clicked: 2, succeeded: 1, failed: 1, messages: ['Renewed for 2 days'] });
  assert.match(text, /浏览器续期/);
  assert.match(text, /成功 1 台，失败 1 台/);
  assert.match(text, /Renewed for 2 days/);
});

test('buildUiMessage 标记 CAPTCHA 已自动通过', () => {
  const text = buildUiMessage({
    clicked: 1,
    succeeded: 1,
    failed: 0,
    captchaSolved: true,
    messages: ['Renewed for 2 days'],
  });
  assert.match(text, /验证并续期/);
  assert.match(text, /CAPTCHA：已通过真实鼠标点击完成验证/);
});

test('buildFailureMessage 对 401 给出重新登录提示', () => {
  const text = buildFailureMessage(new VyceAuthError('登录已过期'));
  assert.match(text, /续期失败/);
  assert.match(text, /登录已过期/);
  assert.match(text, /npm run login/);
  assert.match(text, /VYCE_COOKIE/);
});

test('sendTelegramMessage 正确调用 Bot API', async () => {
  const mock = await startTelegramMock();
  try {
    await sendTelegramMessage({
      token: '123456:TEST-TOKEN',
      chatId: '987654321',
      apiBase: mock.apiBase,
      text: '<b>hello</b>',
    });
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].url, '/bot123456:TEST-TOKEN/sendMessage');
    assert.equal(mock.requests[0].body.chat_id, '987654321');
    assert.equal(mock.requests[0].body.text, '<b>hello</b>');
    assert.equal(mock.requests[0].body.parse_mode, 'HTML');
    assert.equal(mock.requests[0].body.disable_web_page_preview, true);
  } finally {
    await mock.close();
  }
});

test('notifyApiResult 有续期结果时发送消息', async () => {
  const mock = await startTelegramMock();
  try {
    const result = await notifyApiResult({
      config: makeConfig(mock.apiBase),
      logger: silentLogger,
      summary: sampleSummary,
    });
    assert.equal(result.sent, true);
    assert.equal(mock.requests.length, 1);
    assert.match(mock.requests[0].body.text, /tokyo-mini/);
  } finally {
    await mock.close();
  }
});

test('notifyApiResult 全部冷却时不发送（避免刷屏）', async () => {
  const mock = await startTelegramMock();
  try {
    const result = await notifyApiResult({
      config: makeConfig(mock.apiBase),
      logger: silentLogger,
      summary: { ...sampleSummary, renewed: [], failed: [], planned: [] },
    });
    assert.deepEqual(result, { sent: false, reason: 'nothing-to-report' });
    assert.equal(mock.requests.length, 0);
  } finally {
    await mock.close();
  }
});

test('未配置 Telegram 时静默跳过', async () => {
  const result = await notifyApiResult({
    config: { ...makeConfig('https://api.telegram.org'), telegramBotToken: '', telegramChatId: '' },
    logger: silentLogger,
    summary: sampleSummary,
  });
  assert.deepEqual(result, { sent: false, reason: 'not-configured' });
});

test('TELEGRAM_NOTIFY=false 时不发送', async () => {
  const mock = await startTelegramMock();
  try {
    const result = await notifyApiResult({
      config: { ...makeConfig(mock.apiBase), telegramNotify: false },
      logger: silentLogger,
      summary: sampleSummary,
    });
    assert.equal(result.sent, false);
    assert.equal(mock.requests.length, 0);
  } finally {
    await mock.close();
  }
});

test('Telegram API 报错时不影响主流程，只返回 error', async () => {
  const mock = await startTelegramMock({ ok: false, description: 'chat not found' });
  const warnings = [];
  try {
    const result = await notifyApiResult({
      config: makeConfig(mock.apiBase),
      logger: { ...silentLogger, warn: (message) => warnings.push(message) },
      summary: sampleSummary,
    });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'error');
    assert.match(result.error.message, /chat not found/);
    assert.match(warnings[0], /Telegram 通知发送失败/);
  } finally {
    await mock.close();
  }
});

test('notifyFailure 在登录失效时发送失败通知', async () => {
  const mock = await startTelegramMock();
  try {
    const result = await notifyFailure({
      config: makeConfig(mock.apiBase),
      logger: silentLogger,
      error: new VyceAuthError('登录会话无效'),
    });
    assert.equal(result.sent, true);
    assert.match(mock.requests[0].body.text, /登录会话无效/);
    assert.match(mock.requests[0].body.text, /npm run login/);
  } finally {
    await mock.close();
  }
});

test('TELEGRAM_NOTIFY=always 时即使全部冷却也发送每日状态', async () => {
  const mock = await startTelegramMock();
  try {
    const result = await notifyApiResult({
      config: { ...makeConfig(mock.apiBase), telegramNotifyAlways: true },
      logger: silentLogger,
      summary: { ...sampleSummary, renewed: [], failed: [], planned: [] },
    });
    assert.equal(result.sent, true);
    assert.equal(mock.requests.length, 1);
    assert.match(mock.requests[0].body.text, /无需续期/);
  } finally {
    await mock.close();
  }
});

test('buildApiMessage 显示需要手动完成 CAPTCHA', () => {
  const text = buildApiMessage({
    ...sampleSummary,
    renewed: [],
    skipped: [],
    manual: [{ server: { id: 'srv-1', name: 'tokyo-mini' }, error: { code: 'captcha_required' } }],
  });
  assert.match(text, /需要手动验证：1 台/);
  assert.match(text, /CAPTCHA/);
  assert.match(text, /tokyo-mini/);
});

test('notifyApiResult 需要手动验证时附带“去续期”按钮', async () => {
  const mock = await startTelegramMock();
  try {
    const result = await notifyApiResult({
      config: makeConfig(mock.apiBase),
      logger: silentLogger,
      summary: {
        ...sampleSummary,
        renewed: [],
        skipped: [],
        manual: [{ server: { id: 'srv-1', name: 'tokyo-mini' }, error: { code: 'captcha_required' } }],
      },
    });
    assert.equal(result.sent, true);
    const body = mock.requests[0].body;
    assert.equal(body.reply_markup.inline_keyboard[0][0].url, 'https://vyce.cloud/#/servers');
    assert.match(body.reply_markup.inline_keyboard[0][0].text, /去完成验证/);
    assert.match(body.text, /需要手动验证/);
  } finally {
    await mock.close();
  }
});

test('sendTelegramMessage 支持自定义 reply_markup', async () => {
  const mock = await startTelegramMock();
  try {
    await sendTelegramMessage({
      token: '123456:TEST-TOKEN',
      chatId: '42',
      apiBase: mock.apiBase,
      text: 'hi',
      replyMarkup: { inline_keyboard: [[{ text: 'open', url: 'https://vyce.cloud' }]] },
    });
    assert.deepEqual(mock.requests[0].body.reply_markup, {
      inline_keyboard: [[{ text: 'open', url: 'https://vyce.cloud' }]],
    });
  } finally {
    await mock.close();
  }
});

test('notifyTest 未配置时抛出明确错误', async () => {
  await assert.rejects(
    () =>
      notifyTest({
        config: { ...makeConfig('https://api.telegram.org'), telegramBotToken: '' },
        logger: silentLogger,
      }),
    /TELEGRAM_BOT_TOKEN/,
  );
});

