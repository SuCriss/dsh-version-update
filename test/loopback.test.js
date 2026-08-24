/**
 * Loopback fence tests: socket semantics, Host header checks, and the
 * same-origin markers — the trust boundary every route sits behind.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isLoopbackAddress, isLoopbackHostname, isLoopbackRequest } from '../lib/loopback.js'

/** @param {{ remote?: string; host?: string; site?: string; origin?: string }} shape - request facts. */
function fakeRequest({ remote = '127.0.0.1', host = '127.0.0.1:3080', site, origin }) {
  return {
    socket: { remoteAddress: remote },
    headers: {
      ...(host !== undefined ? { host } : {}),
      ...(site !== undefined ? { 'sec-fetch-site': site } : {}),
      ...(origin !== undefined ? { origin } : {}),
    },
  }
}

test('loopback addresses cover 127/8, ::1, and IPv4-mapped forms only', () => {
  for (const good of ['127.0.0.1', '127.8.8.8', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1'.replace('7f00:1', '127.0.0.2')]) {
    assert.equal(isLoopbackAddress(good), true, good)
  }
  for (const bad of [undefined, '', '192.168.1.10', '10.0.0.2', '::2', '::ffff:192.168.0.1', 'fe80::1']) {
    assert.equal(isLoopbackAddress(bad), false, String(bad))
  }
})

test('loopback hostnames accept localhost and bracketed IPv6', () => {
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('[::1]'), true)
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('example.com'), false)
  assert.equal(isLoopbackHostname('localhost.evil.com'), false)
})

test('a request needs a loopback socket AND a loopback Host header', () => {
  assert.equal(isLoopbackRequest(fakeRequest({})), true)
  // Remote LAN address is refused even with everything else perfect.
  assert.equal(isLoopbackRequest(fakeRequest({ remote: '192.168.1.50' })), false)
  // DNS-rebinding style Host header is refused even from loopback.
  assert.equal(isLoopbackRequest(fakeRequest({ host: 'evil.example:3080' })), false)
  // A missing Host header is refused as well.
  const noHost = fakeRequest({})
  delete noHost.headers.host
  assert.equal(isLoopbackRequest(noHost), false)
})

test('cross-site fetch markers are refused; same-origin passes', () => {
  assert.equal(isLoopbackRequest(fakeRequest({ site: 'cross-site' })), false)
  assert.equal(isLoopbackRequest(fakeRequest({ site: 'same-origin' })), true)
  assert.equal(isLoopbackRequest(fakeRequest({ origin: 'http://127.0.0.1:3080' })), true)
  assert.equal(isLoopbackRequest(fakeRequest({ origin: 'http://attacker.example' })), false)
})
