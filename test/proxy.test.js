import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { VyceClient, buildProxyUrl, createProxyDispatcher } from '../src/vyce-client.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

test('buildProxyUrl 支持用户名密码并正确编码', () => {
  const value = buildProxyUrl({ server: 'http://127.0.0.1:7890', username: 'u@x', password: 'p:w' });
  const parsed = new URL(value);
  assert.equal(parsed.protocol, 'http:');
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.port, '7890');
  assert.equal(parsed.username, 'u%40x');
  assert.equal(parsed.password, 'p%3Aw');
});

test('buildProxyUrl 支持 socks5', () => {
  const value = buildProxyUrl({ server: 'socks5://127.0.0.1:1080' });
  assert.equal(new URL(value).protocol, 'socks5:');
});

test('buildProxyUrl 对 VLESS 链接给出 sing-box 提示', () => {
  assert.throws(
    () => buildProxyUrl({ server: 'vless://uuid@example.com:443?type=ws' }),
    /sing-box/,
  );
});

test('buildProxyUrl 对非法地址抛出错误', () => {
  assert.throws(() => buildProxyUrl({ server: 'not a url' }), /格式无效/);
  assert.throws(() => buildProxyUrl({ server: 'ftp://127.0.0.1:21' }), /不支持的代理协议/);
});

test('createProxyDispatcher 对 HTTP 代理创建 dispatcher', () => {
  const dispatcher = createProxyDispatcher({ server: 'http://127.0.0.1:7890' }, silentLogger);
  assert.ok(dispatcher);
});

test('createProxyDispatcher 对 SOCKS 只告警并返回空（浏览器仍可用）', () => {
  const warnings = [];
  const dispatcher = createProxyDispatcher(
    { server: 'socks5://127.0.0.1:1080' },
    { ...silentLogger, warn: (message) => warnings.push(message) },
  );
  assert.equal(dispatcher, undefined);
  assert.match(warnings[0], /SOCKS/);
});

test('createProxyDispatcher 未配置代理时返回空', () => {
  assert.equal(createProxyDispatcher(null, silentLogger), undefined);
  assert.equal(createProxyDispatcher({}, silentLogger), undefined);

test('VyceClient 通过 HTTP 代理发送请求', async () => {
  const seen = [];
  const proxyServer = http.createServer((request, response) => {
    seen.push(request.url);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ user: { id: 1, login: 'proxied-user' } }));
  });
  await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  const port = proxyServer.address().port;

  try {
    const client = new VyceClient({
      baseUrl: 'http://vyce.invalid',
      cookie: 'vyce_session=test',
      proxy: { server: `http://127.0.0.1:${port}` },
      timeoutMs: 5000,
      retries: 0,
      logger: silentLogger,
    });
    const user = await client.getMe();
    assert.equal(user.login, 'proxied-user');
    assert.equal(seen.length, 1);
    assert.match(seen[0], /^http:\/\/vyce\.invalid\/api\/me$/);
  } finally {
    await new Promise((resolve) => proxyServer.close(resolve));
  }
});

});
