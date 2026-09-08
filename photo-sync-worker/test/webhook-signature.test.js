import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyDropboxSignature, timingSafeEqual } from '../src/webhook.js';

const SECRET = 'test-app-secret';
const BODY = JSON.stringify({ list_folder: { accounts: ['dbid:AAA'] } });

test('accepts a correct HMAC-SHA256 hex signature', async () => {
  const sig = createHmac('sha256', SECRET).update(BODY).digest('hex');
  assert.equal(await verifyDropboxSignature(BODY, sig, SECRET), true);
});

test('accepts uppercase hex too', async () => {
  const sig = createHmac('sha256', SECRET).update(BODY).digest('hex').toUpperCase();
  assert.equal(await verifyDropboxSignature(BODY, sig, SECRET), true);
});

test('rejects a wrong signature / wrong secret / missing header', async () => {
  const good = createHmac('sha256', SECRET).update(BODY).digest('hex');
  assert.equal(await verifyDropboxSignature(BODY, good.replace(/.$/, '0'), SECRET), false);
  assert.equal(await verifyDropboxSignature(BODY, createHmac('sha256', 'other').update(BODY).digest('hex'), SECRET), false);
  assert.equal(await verifyDropboxSignature(BODY, '', SECRET), false);
  assert.equal(await verifyDropboxSignature(BODY, good, ''), false);
});

test('rejects a tampered body', async () => {
  const sig = createHmac('sha256', SECRET).update(BODY).digest('hex');
  assert.equal(await verifyDropboxSignature(BODY + ' ', sig, SECRET), false);
});

test('timingSafeEqual', () => {
  assert.ok(timingSafeEqual('abc', 'abc'));
  assert.ok(!timingSafeEqual('abc', 'abd'));
  assert.ok(!timingSafeEqual('abc', 'abcd'));
  assert.ok(!timingSafeEqual('', 'x'));
});
