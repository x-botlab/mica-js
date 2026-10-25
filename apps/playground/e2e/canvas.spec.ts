import { expect, test, type Page } from '@playwright/test';

interface Point {
  readonly x: number;
  readonly y: number;
}

interface SceneWidget extends Point {
  readonly id: string;
  readonly widget: string;
  readonly width: number;
  readonly height: number;
}

interface SceneSnapshot {
  readonly mode: string;
  readonly widgets: readonly SceneWidget[];
}

interface SceneHandle {
  getMode(): string;
  getDocument(): { readonly widgets: readonly SceneWidget[] };
}

interface HostHandle {
  getLayers(): {
    get(instanceId: string): { readonly sequence: number } | undefined;
  };
}

function centerOf(widget: SceneWidget): Point {
  return { x: widget.x + widget.width / 2, y: widget.y + widget.height / 2 };
}

async function sceneState(page: Page): Promise<SceneSnapshot> {
  return page.evaluate(() => {
    const scene = (globalThis as unknown as { micaCanvas: SceneHandle }).micaCanvas;
    return {
      mode: scene.getMode(),
      widgets: scene.getDocument().widgets.map((widget) => ({
        id: widget.id,
        widget: widget.widget,
        x: widget.x,
        y: widget.y,
        width: widget.width,
        height: widget.height,
      })),
    };
  });
}

async function openCanvas(page: Page, path = '/canvas-examples/basic-widgets'): Promise<void> {
  await page.goto(`/#${path}`);
  await page.waitForFunction(
    () => (globalThis as { micaCanvas?: unknown }).micaCanvas !== undefined,
  );
  await expect(page.locator('canvas.mica-canvas-editor__surface')).toBeVisible();
}

async function pagePoint(page: Page, point: Point): Promise<Point> {
  return page.evaluate((target) => {
    const canvas = document.querySelector('canvas.mica-canvas-editor__surface');
    if (canvas === null) {
      throw new Error('the canvas surface is not mounted');
    }
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + target.x, y: rect.top + target.y };
  }, point);
}

async function frameSequence(page: Page, instanceId: string): Promise<number> {
  return page.evaluate((id) => {
    const host = (globalThis as unknown as { micaWidgetHost: HostHandle }).micaWidgetHost;
    return host.getLayers().get(id)?.sequence ?? 0;
  }, instanceId);
}

async function switchMode(page: Page, label: '编辑' | '运行'): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect
    .poll(async () => (await sceneState(page)).mode)
    .toBe(label === '运行' ? 'run' : 'edit');
}

test('renders the basic widget example', async ({ page }) => {
  await openCanvas(page);
  const state = await sceneState(page);
  expect(state.widgets.map((widget) => widget.widget)).toEqual([
    'demo:button',
    'lab:power-switch',
    'lab:led',
    'lab:led',
  ]);
  await expect(page.getByText('诊断 0')).toBeVisible();
});

test('turns a drag into a committed placement and a revision', async ({ page }) => {
  await openCanvas(page);
  const before = await sceneState(page);
  const button = before.widgets.find((widget) => widget.widget === 'demo:button');
  expect(button).toBeDefined();
  if (button === undefined) {
    return;
  }

  const start = await pagePoint(page, centerOf(button));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 100, start.y, { steps: 6 });
  await page.mouse.up();

  await expect
    .poll(async () => {
      const { widgets } = await sceneState(page);
      return widgets.find((widget) => widget.id === button.id)?.x;
    })
    .toBeGreaterThan(button.x + 80);
  await expect(page.getByText('rev 1')).toBeVisible();
});

test('routes a button press through the indicator into the LED', async ({ page }) => {
  await openCanvas(page);
  await switchMode(page, '运行');
  const state = await sceneState(page);
  const button = state.widgets.find((widget) => widget.widget === 'demo:button');
  const led = state.widgets.find(
    (widget) => widget.widget === 'lab:led' && widget.id === '00000203-0000-4000-8000-000000000001',
  );
  expect(button).toBeDefined();
  expect(led).toBeDefined();
  if (button === undefined || led === undefined) {
    return;
  }

  const before = await frameSequence(page, led.id);
  const point = await pagePoint(page, centerOf(button));
  await page.mouse.click(point.x, point.y);

  // The widget publishes into D1.input; the indicator republishes it as D1.output.
  await expect(page.getByText(/D1\.input/).first()).toBeVisible();
  await expect.poll(() => frameSequence(page, led.id), { timeout: 5000 }).toBeGreaterThan(before);
  await expect(page.getByText('诊断 0')).toBeVisible();
});

test('edits a selected LED through the property panel', async ({ page }) => {
  await openCanvas(page);
  const state = await sceneState(page);
  const led = state.widgets.find((widget) => widget.widget === 'lab:led');
  expect(led).toBeDefined();
  if (led === undefined) {
    return;
  }

  const point = await pagePoint(page, centerOf(led));
  await page.mouse.click(point.x, point.y);
  await expect(page.getByText('lab:led', { exact: true })).toBeVisible();

  const color = page.getByLabel('onColor', { exact: true });
  await color.fill('#00ff88');
  await color.blur();

  await expect(page.getByText('rev 1')).toBeVisible();
  const row = page.locator('[data-property="onColor"]');
  await expect(row.getByText('已覆盖')).toBeVisible();
  await expect(page.getByText('诊断 0')).toBeVisible();
});

test('adds a widget from the palette on the simple canvas', async ({ page }) => {
  await openCanvas(page, '/canvas-examples/simple-canvas');
  const before = (await sceneState(page)).widgets.length;
  await page.getByRole('button', { name: /动画/ }).first().click();
  await expect.poll(async () => (await sceneState(page)).widgets.length).toBe(before + 1);
  await expect(page.getByText('rev 1')).toBeVisible();
});

test('switches between edit and run mode', async ({ page }) => {
  await openCanvas(page);
  await switchMode(page, '运行');
  await switchMode(page, '编辑');
  const state = await sceneState(page);
  expect(state.mode).toBe('edit');
  expect(state.widgets).toHaveLength(4);
});
