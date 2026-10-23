import { expect, test, type Page } from '@playwright/test';

/**
 * The simulator page drives the committed device examples through the real executor: the button
 * scenario also proves the widget sandbox wiring, because its input only arrives through
 * `@mica-js/sandbox` → `WidgetHost` → `DeviceSimExecutor.deliver`.
 */
async function openSimulator(page: Page): Promise<void> {
  await page.goto('/#/simulator');
  await expect(page.getByTestId('scenario-button')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('sim-state')).toHaveAttribute('data-state', 'ready');
}

async function probe(page: Page, id: string): Promise<string | null> {
  return page.getByTestId(`probe-${id}`).getAttribute('data-value');
}

async function simTimePs(page: Page): Promise<number> {
  return Number(await page.getByTestId('sim-time').getAttribute('data-ps'));
}

async function inputRows(page: Page): Promise<number> {
  return page.locator('[data-testid="trace-row"][data-kind="input"]').count();
}

test('runs the button scenario inside the widget sandbox and closes the contact', async ({
  page,
}) => {
  await openSimulator(page);

  // The widget really lives in the sandbox iframe; the bench has no in-process shortcut.
  await expect(page.locator('iframe')).toHaveCount(1);
  await expect(page.getByTestId('reset-S1')).toHaveAttribute('data-reset', 'supported');
  expect(await probe(page, 'contact')).toBe('open');

  const canvas = page.locator('canvas.mica-canvas-editor__surface');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) {
    return;
  }

  // The editor starts with an identity viewport: the widget sits at (24, 16) + 200×96.
  // Pressing the step button through `click()` keeps the pointer down on the canvas, which a
  // coordinate click cannot do (Playwright would move the mouse and release the button).
  const stepButton = page.getByTestId('step');
  await page.mouse.move(box.x + 124, box.y + 64);
  await page.mouse.down();
  await expect.poll(() => inputRows(page)).toBeGreaterThan(0);
  await stepButton.evaluate((element) => (element as HTMLButtonElement).click());

  await expect.poll(() => probe(page, 'contact')).toBe('closed');
  await expect.poll(() => probe(page, 'sense')).toBe('1');
  expect(await simTimePs(page)).toBeGreaterThan(0);

  await page.mouse.up();
  await expect.poll(() => inputRows(page)).toBeGreaterThan(1);
  await stepButton.evaluate((element) => (element as HTMLButtonElement).click());
  await expect.poll(() => probe(page, 'contact')).toBe('open');
  await expect.poll(() => probe(page, 'sense')).toBe('0');
});

test('reports unsupported model capabilities and rejects an invalid payload', async ({ page }) => {
  await openSimulator(page);
  await page.getByTestId('scenario-mcu').click();

  await expect(page.getByTestId('scenario-mcu')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('sim-state')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('reset-U1')).toHaveAttribute('data-reset', 'unsupported');
  await expect(page.getByTestId('canvas-note')).toBeVisible();
  await expect(page.getByTestId('topics')).toContainText('U1.firmwarePatch');

  // No canvas for a bytes-only model, so the previous sandbox must be gone.
  await expect.poll(() => page.locator('iframe').count()).toBe(0);

  await page.getByTestId('send-invalid').click();
  await page.getByTestId('step').click();

  await expect(page.getByTestId('sim-error')).toBeVisible();
  // A rejected payload never faults the scheduler: advancing stays legal.
  await expect(page.getByTestId('sim-state')).toHaveAttribute('data-state', 'ready');
  await expect(
    page.locator('[data-testid="diagnostic-row"][data-code="bench/delivery-rejected"]'),
  ).toBeVisible();
  expect(await simTimePs(page)).toBe(0);

  await page.getByTestId('preset-1').click();
  await page.getByTestId('send-bytes').click();
  await page.getByTestId('step').click();
  await expect(page.getByTestId('sim-state')).toHaveAttribute('data-state', 'ready');
  expect(await simTimePs(page)).toBeGreaterThan(0);
});

test('replays the scenario twice with the same trace digest', async ({ page }) => {
  await openSimulator(page);
  await page.getByTestId('replay').click();
  const result = page.getByTestId('replay-result');
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result).toHaveAttribute('data-equal', 'true');
  await expect(result).toContainText('确定性回放一致');
});

test('keeps the clock under host control for run, pause and reset', async ({ page }) => {
  await openSimulator(page);
  await page.getByTestId('run').click();
  await expect.poll(() => simTimePs(page)).toBeGreaterThan(0);
  await page.getByTestId('pause').click();

  const paused = await simTimePs(page);
  await page.waitForTimeout(250);
  expect(await simTimePs(page)).toBe(paused);

  await page.getByTestId('reset').click();
  await expect.poll(() => simTimePs(page)).toBe(0);
  await expect(page.getByTestId('step-count')).toHaveAttribute('data-steps', '0');
  await expect(page.getByTestId('sim-state')).toHaveAttribute('data-state', 'ready');
});

test('switching scenarios leaves no sandbox or executor behind', async ({ page }) => {
  await openSimulator(page);
  await expect(page.locator('iframe')).toHaveCount(1);

  await page.getByTestId('scenario-mcu').click();
  await expect.poll(() => page.locator('iframe').count()).toBe(0);
  await expect(page.getByTestId('sim-state')).toHaveAttribute('data-state', 'ready');

  await page.getByTestId('scenario-button').click();
  await expect(page.getByTestId('sim-state')).toHaveAttribute('data-state', 'ready');
  await expect.poll(() => page.locator('iframe').count()).toBe(1);
  await expect(page.getByTestId('probe-contact')).toHaveAttribute('data-value', 'open');
});

test('stays usable on a narrow viewport without blocking overflow', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 820 });
  await openSimulator(page);

  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.inner + 1);

  await expect(page.getByTestId('step')).toBeVisible();
  await page.getByTestId('step').click();
  expect(await simTimePs(page)).toBeGreaterThan(0);
  await expect(page.locator('canvas.mica-canvas-editor__surface')).toBeVisible();
});
