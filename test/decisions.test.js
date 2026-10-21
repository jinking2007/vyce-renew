import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOUR_MS,
  computeRenewalDecision,
  formatDuration,
  formatTimestamp,
  matchesServer,
  selectServers,
  toTimestamp,
} from '../src/decisions.js';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');

function freeServer(overrides = {}) {
  return {
    id: 'srv-1',
    name: 'my-vps',
    source: 'free',
    status: 'running',
    suspended: false,
    expiresAt: NOW + 10 * HOUR_MS,
    ...overrides,
  };
}

test('免费服务器剩余 10 小时：应当续期', () => {
  const decision = computeRenewalDecision(freeServer(), NOW);
  assert.equal(decision.action, 'renew');
  assert.equal(decision.reason, 'due');
  assert.equal(decision.remainingMs, 10 * HOUR_MS);
});

test('免费服务器剩余正好 24 小时：应当续期（边界）', () => {
  const decision = computeRenewalDecision(freeServer({ expiresAt: NOW + 24 * HOUR_MS }), NOW);
  assert.equal(decision.action, 'renew');
});

test('免费服务器剩余 36 小时：冷却中，等待 12 小时', () => {
  const decision = computeRenewalDecision(freeServer({ expiresAt: NOW + 36 * HOUR_MS }), NOW);
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'cooldown');
  assert.equal(decision.cooldownMs, 12 * HOUR_MS);
});

test('已关机的免费服务器：即使剩余时间很多也应续期并开机', () => {
  const decision = computeRenewalDecision(
    freeServer({ status: 'stopped', expiresAt: NOW + 40 * HOUR_MS }),
    NOW,
  );
  assert.equal(decision.action, 'renew');
  assert.equal(decision.reason, 'stopped');
});

test('已过期的免费服务器：应当立即续期', () => {
  const decision = computeRenewalDecision(freeServer({ expiresAt: NOW - HOUR_MS }), NOW);
  assert.equal(decision.action, 'renew');
  assert.equal(decision.reason, 'late');
});

test('付费服务器：跳过', () => {
  const decision = computeRenewalDecision(freeServer({ source: 'paid' }), NOW);
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'paid');
});

test('已暂停的免费服务器：跳过', () => {
  const decision = computeRenewalDecision(freeServer({ suspended: true }), NOW);
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'suspended');
});

test('创建中的服务器：跳过', () => {
  const decision = computeRenewalDecision(freeServer({ status: 'creating' }), NOW);
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'creating');
});

test('没有到期时间的服务器：跳过', () => {
  const decision = computeRenewalDecision(freeServer({ expiresAt: null }), NOW);
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'no-expiry');
  assert.equal(decision.expiresAt, null);
});

test('支持 ISO 时间和秒级时间戳', () => {
  const iso = computeRenewalDecision(
    freeServer({ expiresAt: '2026-01-01T10:00:00.000Z' }),
    NOW,
  );
  assert.equal(iso.action, 'renew');
  assert.equal(iso.remainingMs, 10 * HOUR_MS);

  const seconds = toTimestamp((NOW + 5 * HOUR_MS) / 1000);
  assert.equal(seconds, NOW + 5 * HOUR_MS);
});

test('matchesServer 支持按 ID 或名称、忽略大小写', () => {
  const server = freeServer({ id: 'AbC123', name: 'My-VPS' });
  assert.equal(matchesServer(server, 'abc123'), true);
  assert.equal(matchesServer(server, 'my-vps'), true);
  assert.equal(matchesServer(server, 'other'), false);
});

test('selectServers 未配置筛选时返回全部', () => {
  const servers = [freeServer({ id: 'a' }), freeServer({ id: 'b' })];
  assert.equal(selectServers(servers, []).length, 2);
});

test('selectServers 按筛选条件过滤并保持顺序', () => {
  const servers = [freeServer({ id: 'a', name: 'one' }), freeServer({ id: 'b', name: 'two' })];
  assert.deepEqual(
    selectServers(servers, ['two']).map((server) => server.id),
    ['b'],
  );
});

test('formatDuration 输出可读文本', () => {
  assert.equal(formatDuration(25 * HOUR_MS), '1天 1小时');
  assert.equal(formatDuration(90 * 60 * 1000), '1小时 30分');
  assert.equal(formatDuration(65 * 1000), '1分 05秒');
  assert.equal(formatDuration(30 * 1000), '30秒');
});

test('formatTimestamp 处理无效值', () => {
  assert.equal(formatTimestamp(null), '未知');
  assert.equal(formatTimestamp('not-a-date'), '未知');
  assert.equal(formatTimestamp('2026-01-01T00:00:00.000Z'), '2026-01-01 00:00:00 UTC');
});
