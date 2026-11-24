import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchJson } from '../src/providers/types';

test('request timeout includes a body that stalls after successful headers', async () => {
  const native = globalThis.fetch;
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream({ start(controller) {
    init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted body', 'AbortError')));
  } }), { status: 200 });
  try {
    await assert.rejects(fetchJson('https://example.invalid', { timeoutMs: 15, retries: 1 }), { name: 'AbortError' });
  } finally { globalThis.fetch = native; }
});

test('HTTP 403 is not retried even if retries are enabled', async () => {
  const native = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('Forbidden', { status: 403 }); };
  try {
    await assert.rejects(fetchJson('https://example.invalid', { retries: 2 }), /HTTP 403/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = native; }
});
