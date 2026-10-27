import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/fixtures/sandbox-rpc.html');
});

test('transfers a MessagePort through the sandbox handshake and uses dynamic core RPC', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const path = '/e2e/fixtures/sandbox-rpc-host.ts';
    const fixture = await import(path);
    return fixture.basic();
  });
  expect(result.handshake).toEqual({ connected: true, origin: 'null', document: 'undefined' });
  expect(result.sum).toBe(42);
  expect(result.hostReply).toBe('host:roundtrip');
  expect(result.listenerCount).toBe(1);
  expect(result.order).toEqual(['event:first', 'response:returned:first']);
  expect(result.remaining).toBe(0);
  expect(result.errors).toEqual([]);
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('explicitly disposes RPC subscriptions, pending calls and ports on sandbox termination', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const path = '/e2e/fixtures/sandbox-rpc-host.ts';
    const fixture = await import(path);
    return fixture.lifecycle();
  });
  expect(result).toEqual({
    subscriptionsBefore: 1,
    subscriptionsAfter: 0,
    pendingError: 'RpcDisconnectedError',
    afterDispose: 'RpcDisconnectedError',
    state: 'terminated',
  });
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('transfers ImageBitmap method results, event arguments and proxy arguments', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const path = '/e2e/fixtures/sandbox-rpc-host.ts';
    const fixture = await import(path);
    return fixture.transfers();
  });
  test.skip(!result.supported, result.reason);
  expect(result.resultSize).toEqual([3, 2]);
  expect(result.pixel).toEqual([255, 0, 0, 255]);
  expect(result.eventSizes).toEqual([[3, 2]]);
  expect(result.widthsAfterResult).toEqual([0]);
  expect(result.widthsAfterEvent).toEqual([0, 0]);
  expect(result.argumentWidth).toBe(7);
  expect(result.outgoingWidth).toBe(0);
  await expect(page.locator('iframe')).toHaveCount(0);
});
