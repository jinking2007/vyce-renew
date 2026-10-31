import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSingBoxConfig,
  isVlessUrl,
  parseVlessUrl,
} from '../src/sing-box.js';

test('isVlessUrl 识别 vless 链接', () => {
  assert.equal(isVlessUrl('vless://uuid@example.com:443'), true);
  assert.equal(isVlessUrl('  VLESS://uuid@example.com:443'), true);
  assert.equal(isVlessUrl('http://127.0.0.1:7890'), false);
  assert.equal(isVlessUrl(''), false);
});

test('parseVlessUrl 解析 reality + tcp + vision', () => {
  const outbound = parseVlessUrl(
    'vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?encryption=none&security=reality&sni=www.example.com&fp=chrome&pbk=PUBKEY&sid=abcd&type=tcp&flow=xtls-rprx-vision#node',
  );
  assert.equal(outbound.type, 'vless');
  assert.equal(outbound.server, '1.2.3.4');
  assert.equal(outbound.server_port, 443);
  assert.equal(outbound.uuid, '11111111-2222-3333-4444-555555555555');
  assert.equal(outbound.flow, 'xtls-rprx-vision');
  assert.equal(outbound.tls.enabled, true);
  assert.equal(outbound.tls.server_name, 'www.example.com');
  assert.equal(outbound.tls.utls.fingerprint, 'chrome');
  assert.deepEqual(outbound.tls.reality, {
    enabled: true,
    public_key: 'PUBKEY',
    short_id: 'abcd',
  });
  assert.equal(outbound.transport, undefined);
});

test('parseVlessUrl 解析 ws + tls', () => {
  const outbound = parseVlessUrl(
    'vless://uuid@example.com:8443?security=tls&sni=cdn.example.com&type=ws&path=%2Fws&host=cdn.example.com&alpn=h2%2Chttp%2F1.1',
  );
  assert.equal(outbound.tls.server_name, 'cdn.example.com');
  assert.deepEqual(outbound.transport, {
    type: 'ws',
    path: '/ws',
    headers: { Host: 'cdn.example.com' },
  });
  assert.deepEqual(outbound.tls.alpn, ['h2', 'http/1.1']);
});

test('parseVlessUrl 解析 grpc', () => {
  const outbound = parseVlessUrl(
    'vless://uuid@example.com:443?security=tls&type=grpc&serviceName=my-service',
  );
  assert.deepEqual(outbound.transport, { type: 'grpc', service_name: 'my-service' });
});

test('parseVlessUrl 对缺少 pbk 的 reality 报错', () => {
  assert.throws(
    () => parseVlessUrl('vless://uuid@example.com:443?security=reality&sni=a.com&type=tcp'),
    /pbk/,
  );
});

test('parseVlessUrl 对不支持的传输类型报错', () => {
  assert.throws(
    () => parseVlessUrl('vless://uuid@example.com:443?type=quic'),
    /暂不支持/,
  );
});

test('buildSingBoxConfig 生成 mixed inbound 和 VLESS 出口', () => {
  const outbound = parseVlessUrl('vless://uuid@example.com:443?security=tls');
  const config = buildSingBoxConfig(outbound, 7890);
  assert.equal(config.inbounds[0].type, 'mixed');
  assert.equal(config.inbounds[0].listen, '127.0.0.1');
  assert.equal(config.inbounds[0].listen_port, 7890);
  assert.equal(config.outbounds[0].tag, 'proxy');
  assert.equal(config.outbounds[1].type, 'direct');
  assert.equal(config.route.final, 'proxy');
});
