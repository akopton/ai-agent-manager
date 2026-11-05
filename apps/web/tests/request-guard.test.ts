import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkHost, checkMutationRequest, isLoopbackHost } from '@/lib/server/request-guard';

test('accepts only loopback Host headers', () => {
  for (const host of ['127.0.0.1', '127.0.0.1:3000', 'localhost', 'LOCALHOST:3000', '[::1]:3000']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of [
    null,
    '',
    'evil.example',
    'evil.example:3000',
    '127.0.0.1.evil.example',
    'localhost.evil.example',
    'user@127.0.0.1',
    '127.0.0.1:3000/path',
    '127.0.0.2:3000',
    '0.0.0.0:3000',
    '::1',
  ]) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
  assert.equal(checkHost(new Headers({ host: 'evil.example' }))?.code, 'forbidden_host');
  assert.equal(checkHost(new Headers({ host: '127.0.0.1:3000' })), undefined);
});

test('requires the exact application Origin for mutations', () => {
  const headers = (values: Record<string, string>) => new Headers(values);
  assert.equal(
    checkMutationRequest(headers({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' })),
    undefined,
  );
  assert.equal(
    checkMutationRequest(headers({ host: 'localhost:3000', origin: 'http://LOCALHOST:3000' })),
    undefined,
  );
  for (const origin of [
    'http://evil.example',
    'http://127.0.0.1:3001',
    'https://127.0.0.1:3000',
    'http://localhost:3000',
    'null',
  ]) {
    assert.equal(
      checkMutationRequest(headers({ host: '127.0.0.1:3000', origin }))?.code,
      'forbidden_origin',
      origin,
    );
  }
  assert.equal(checkMutationRequest(headers({ host: '127.0.0.1:3000' }))?.code, 'forbidden_origin');
  // DNS rebinding: the attacker controls both Host and Origin, so the Host check must reject it.
  assert.equal(
    checkMutationRequest(headers({ host: 'evil.example:3000', origin: 'http://evil.example:3000' }))
      ?.code,
    'forbidden_host',
  );
});
