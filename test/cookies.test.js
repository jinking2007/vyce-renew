import test from 'node:test';
import assert from 'node:assert/strict';
import { cookieDomainMatches, cookieHeaderFromState, parseCookieString } from '../src/cookies.js';

test('parseCookieString 解析浏览器 Cookie 请求头', () => {
  assert.deepEqual(parseCookieString('a=1; b=hello world; c=x=y'), [
    { name: 'a', value: '1' },
    { name: 'b', value: 'hello world' },
    { name: 'c', value: 'x=y' },
  ]);
});

test('parseCookieString 支持直接粘贴带 Cookie: 前缀的请求头', () => {
  assert.deepEqual(parseCookieString('Cookie: a=1; b=2'), [
    { name: 'a', value: '1' },
    { name: 'b', value: '2' },
  ]);
  assert.deepEqual(parseCookieString('  cookie:  vyce_session=abc  '), [
    { name: 'vyce_session', value: 'abc' },
  ]);
});

test('parseCookieString 忽略空值和非法片段', () => {
  assert.deepEqual(parseCookieString(' ; broken ; =novalue; ok=1 ; '), [{ name: 'ok', value: '1' }]);
  assert.deepEqual(parseCookieString(''), []);
  assert.deepEqual(parseCookieString(null), []);
});

test('cookieDomainMatches 支持主域名和子域名', () => {
  assert.equal(cookieDomainMatches('vyce.cloud'), true);
  assert.equal(cookieDomainMatches('.vyce.cloud'), true);
  assert.equal(cookieDomainMatches('.VYCE.CLOUD'), true);
  assert.equal(cookieDomainMatches('evilvyce.cloud'), false);
  assert.equal(cookieDomainMatches('example.com'), false);
  assert.equal(cookieDomainMatches(''), false);
});

test('cookieHeaderFromState 只输出目标域名且未过期的 Cookie', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const state = {
    cookies: [
      { name: 'vyce_session', value: 'abc', domain: 'vyce.cloud', expires: -1 },
      { name: 'extra', value: '1', domain: '.vyce.cloud', expires: now / 1000 + 60 },
      { name: 'expired', value: 'old', domain: 'vyce.cloud', expires: now / 1000 - 60 },
      { name: 'other', value: 'x', domain: '.github.com', expires: -1 },
    ],
  };
  assert.equal(cookieHeaderFromState(state, { now }), 'vyce_session=abc; extra=1');
});

test('cookieHeaderFromState 对空 state 返回空字符串', () => {
  assert.equal(cookieHeaderFromState(null), '');
  assert.equal(cookieHeaderFromState({}), '');
});
