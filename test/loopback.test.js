/**
 * Trust-fence tests: these routes reach the network, write the machine's global
 * npm tree, and can end the host process, so the fence is the plugin's most
 * security-relevant unit.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isIPv4Loopback, isLoopbackAddress, isLoopbackHostname, isLoopbackRequest } from '../lib/loopback.js'

/**
 * Build a minimal request stand-in.
 * @param {{ address?: string; headers?: Record<string, string> }} [options] - socket address and headers.
 * @returns {import('node:http').IncomingMessage} the request stand-in.
 */
const request = (options = {}) => ({
  socket: { remoteAddress: options.address ?? '127.0.0.1' },
  headers: { host: '127.0.0.1:5173', ...options.headers },
})

test('isIPv4Loopback accepts 127/8 and rejects everything else', () => {
  for (const good of ['127.0.0.1', '127.1.2.3', '127.255.255.255', '127.0.0.255']) {
    assert.equal(isIPv4Loopback(good), true, good)
  }
  for (const bad of ['128.0.0.1', '10.0.0.1', '0.0.0.0', '127.0.0', '127.0.0.1.5', '127.0.0.256', '127.0.0.a', '']) {
    assert.equal(isIPv4Loopback(bad), false, bad)
  }
})

test('isLoopbackAddress covers IPv6 loopback and IPv4-mapped forms', () => {
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::FFFF:127.0.0.1'), true, 'case-insensitive mapped form')
  assert.equal(isLoopbackAddress('::ffff:10.0.0.1'), false, 'a mapped non-loopback address')
  assert.equal(isLoopbackAddress('::2'), false)
  assert.equal(isLoopbackAddress(undefined), false)
})

test('isLoopbackHostname accepts the loopback authorities only', () => {
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('[::1]'), true)
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('example.com'), false)
  assert.equal(isLoopbackHostname('localhost.evil.com'), false, 'a suffix must not pass as localhost')
})

test('a same-origin loopback request passes the fence', () => {
  assert.equal(isLoopbackRequest(request()), true, 'no Origin at all (a plain navigation)')
  assert.equal(isLoopbackRequest(request({
    headers: { origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-origin' },
  })), true)
  assert.equal(isLoopbackRequest(request({
    address: '::1',
    headers: { host: '[::1]:5173', origin: 'http://[::1]:5173' },
  })), true, 'IPv6 loopback end to end')
})

test('the socket address is authoritative and never overridden by headers', () => {
  assert.equal(isLoopbackRequest(request({ address: '192.168.1.20' })), false)
  assert.equal(isLoopbackRequest(request({
    address: '192.168.1.20',
    headers: { host: '127.0.0.1:5173', 'x-forwarded-for': '127.0.0.1' },
  })), false, 'X-Forwarded-For must not launder a remote peer')
})

test('a non-loopback or unusable Host header fails the fence', () => {
  // A LAN-reachable host answering on its own name would otherwise expose the
  // routes to any browser that can resolve it.
  assert.equal(isLoopbackRequest(request({ headers: { host: 'my-laptop.local:5173' } })), false)
  assert.equal(isLoopbackRequest(request({ headers: { host: 'evil.com' } })), false)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), false, 'absent Host')
  assert.equal(isLoopbackRequest(request({ headers: { host: 'http://[bad' } })), false, 'unparsable Host')
})

test('a cross-site or cross-origin request fails the fence', () => {
  assert.equal(isLoopbackRequest(request({ headers: { 'sec-fetch-site': 'cross-site' } })), false)
  assert.equal(isLoopbackRequest(request({ headers: { origin: 'http://evil.com' } })), false)
  assert.equal(isLoopbackRequest(request({
    headers: { origin: 'http://127.0.0.1:9999' },
  })), false, 'a different port on the same loopback host is a different origin')
  assert.equal(isLoopbackRequest(request({ headers: { origin: 'not a url' } })), false)
})
