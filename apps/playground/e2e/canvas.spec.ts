import { expect, test, type Page } from '@playwright/test';

/** The mounted scene the playground exposes in dev builds. */
interface SceneHandle {
  readonly mode: string;
  readonly document: {
    readonly widgets: readonly {
      readonly id: string;
      readonly widget: string;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }[];
  };
}

/** The widget host is exposed too, so a test can watch a layer repaint. */
interface HostHandle {
  readonly layers: {
    list(): readonly {
      readonly instanceId: string;
      readonly sequence: number;
      readonly bitmap: unknown;
    }[];
    get(instanceId: string): { readonly sequence: number } | undefined;
  };
}

interface Point {
  readonly x: number;
  readonly y: number;
}

type DemoWidget = SceneHandle['document']['widgets'][number];

/** Instance center in document coordinates, so a test never depends on the demo's geometry. */
function centerOf(widget: DemoWidget): Point {
  return { x: widget.x + widget.width / 2, y: widget.y + widget.height / 2 };
}

/** Frame counter of one instance; a remount restarts it at 1. */
async function frameSequence(page: Page, instanceId: string): Promise<number> {
  return page.evaluate((id) => {
    const host = (globalThis as unknown as { micaWidgetHost: HostHandle }).micaWidgetHost;
    return host.layers.get(id)?.sequence ?? 0;
  }, instanceId);
}

async function layerCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (globalThis as unknown as { micaWidgetHost: HostHandle }).micaWidgetHost.layers.list().length,
  );
}

async function demoWidget(page: Page, ref: string): Promise<DemoWidget> {
  const widget = (await sceneState(page)).document.widgets.find((entry) => entry.widget === ref);
  if (widget === undefined) {
    throw new Error(`the demo document has no ${ref} instance`);
  }
  return widget;
}

/**
 * Switches mode and waits until the rebuild finished.
 *
 * A switch drops and re-creates every instance, so the run-mode driver only starts afterwards: a
 * new segment frame is the signal that both the reset and the remount are done.
 */
async function switchMode(page: Page, label: '编辑' | '运行'): Promise<void> {
  const segment = await demoWidget(page, 'demo:segment');
  const before = await frameSequence(page, segment.id);
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect
    .poll(async () => (await sceneState(page)).mode)
    .toBe(label === '运行' ? 'run' : 'edit');

  if (label === '运行') {
    await expect.poll(() => frameSequence(page, segment.id)).toBeGreaterThan(before);
    return;
  }
  // Back in edit mode nothing repaints the segment, and the remount left exactly one frame.
  await expect.poll(() => frameSequence(page, segment.id)).toBe(1);
  const { document } = await sceneState(page);
  await expect.poll(() => layerCount(page)).toBe(document.widgets.length);
}

async function openCanvas(page: Page): Promise<void> {
  await page.goto('/#/canvas');
  await page.waitForFunction(
    () => (globalThis as { micaCanvas?: unknown }).micaCanvas !== undefined,
  );
  await expect(page.locator('canvas.mica-canvas-editor__surface')).toBeVisible();
}

async function sceneState(page: Page): Promise<SceneHandle> {
  return page.evaluate(() => {
    const scene = (globalThis as unknown as { micaCanvas: SceneHandle }).micaCanvas;
    return {
      mode: scene.mode,
      document: {
        widgets: scene.document.widgets.map((widget) => ({
          id: widget.id,
          widget: widget.widget,
          x: widget.x,
          y: widget.y,
          width: widget.width,
          height: widget.height,
        })),
      },
    };
  });
}

/** Document point → page coordinates; the scene mounts at scale 1 with the origin top-left. */
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

/** The editor paints with `setTransform(dpr * scale, …, dpr * x, dpr * y)`, so this is the viewport. */
async function canvasTransform(
  page: Page,
): Promise<{ readonly scale: number; readonly x: number; readonly y: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas.mica-canvas-editor__surface');
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('the canvas surface is not mounted');
    }
    const transform = canvas.getContext('2d')?.getTransform();
    return { scale: transform?.a ?? 1, x: transform?.e ?? 0, y: transform?.f ?? 0 };
  });
}

test('draws every instance of the demo document', async ({ page }) => {
  await openCanvas(page);
  const { document } = await sceneState(page);
  expect(document.widgets.map((widget) => widget.widget)).toEqual([
    'demo:image',
    'demo:segment',
    'demo:segment',
    'demo:button',
  ]);
  await expect(page.getByText('诊断 0')).toBeVisible();
});

test('turns a drag into a committed placement and a document revision', async ({ page }) => {
  await openCanvas(page);
  const before = await sceneState(page);
  const button = before.document.widgets.find((widget) => widget.widget === 'demo:button');
  if (button === undefined) {
    throw new Error('the demo document has no button instance');
  }

  const start = await pagePoint(page, centerOf(button));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await page.mouse.move(start.x + (100 * step) / 6, start.y);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();

  await expect
    .poll(async () => {
      const { document } = await sceneState(page);
      return document.widgets.find((widget) => widget.widget === 'demo:button')?.x;
    })
    .toBeGreaterThanOrEqual((button?.x ?? 0) + 90);
  await expect(page.getByText('rev 1')).toBeVisible();
});

test('delivers to the segment and logs the button publish in run mode', async ({ page }) => {
  await openCanvas(page);
  await switchMode(page, '运行');

  const button = await demoWidget(page, 'demo:button');
  const point = await pagePoint(page, centerOf(button));
  await page.mouse.click(point.x, point.y);

  await expect(page.getByText('demo-mcu.key').first()).toBeVisible();
  await expect(page.getByText('诊断 0')).toBeVisible();
});

test('repaints the segment from the run-mode timer', async ({ page }) => {
  await openCanvas(page);
  const segment = await demoWidget(page, 'demo:segment');

  // The mount already produced one frame; the driver's deliveries have to add more.
  const mounted = await frameSequence(page, segment.id);
  await page.getByRole('button', { name: '运行', exact: true }).click();

  await expect
    .poll(() => frameSequence(page, segment.id), { timeout: 5000 })
    .toBeGreaterThan(mounted);
});

test('edits a selected instance through the property panel', async ({ page }) => {
  await openCanvas(page);
  const segment = await demoWidget(page, 'demo:segment');

  // Select the segment in edit mode: the panel shows its definition.
  const point = await pagePoint(page, centerOf(segment));
  await page.mouse.click(point.x, point.y);
  await expect(page.getByText('demo:segment', { exact: true })).toBeVisible();

  const color = page.getByLabel('color', { exact: true });
  await expect(color).toHaveValue('#FF3B30');
  await color.fill('#00ff88');
  await color.blur();

  await expect(page.getByText('rev 1')).toBeVisible();
  const colorRow = page.locator('[data-property="color"]');
  await expect(colorRow.getByText('已覆盖')).toBeVisible();
  await expect(page.getByText('诊断 0')).toBeVisible();

  // The binding panel keeps showing the endpoint the document declares.
  await expect(page.getByLabel('value 绑定')).toHaveValue('demo-mcu:display');

  // Reset drops the override again.
  await colorRow.getByRole('button', { name: '重置' }).click();
  await expect(page.getByText('rev 2')).toBeVisible();
  await expect(colorRow.getByText('已覆盖')).toBeHidden();
});

test('offers only complementary binding candidates', async ({ page }) => {
  await openCanvas(page);
  const button = await demoWidget(page, 'demo:button');

  const point = await pagePoint(page, centerOf(button));
  await page.mouse.click(point.x, point.y);

  const select = page.getByLabel('press 绑定');
  await expect(select).toHaveValue('demo-mcu:key');
  // A boolean widget output pairs with the boolean schematic inputs only.
  const labels = await select.locator('option').allTextContents();
  expect(labels).toEqual([
    '未绑定',
    'demo-mcu.key · input · boolean',
    'demo-mcu.led · input · boolean',
  ]);
});

test('zooms and pans in run mode without reaching a widget', async ({ page }) => {
  await openCanvas(page);
  const button = await demoWidget(page, 'demo:button');
  await switchMode(page, '运行');

  const before = await canvasTransform(page);
  const buttonFrames = await frameSequence(page, button.id);

  // Wheel zooms around the pointer; the transform is the viewport, and nothing is published.
  const anchor = await pagePoint(page, centerOf(button));
  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.wheel(0, -240);
  await expect.poll(async () => (await canvasTransform(page)).scale).toBeGreaterThan(before.scale);

  // The middle button pans over the button instance without pressing it.
  const zoomed = await canvasTransform(page);
  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(anchor.x + 60, anchor.y + 40, { steps: 5 });
  await page.mouse.up({ button: 'middle' });

  await expect.poll(async () => (await canvasTransform(page)).x).toBeGreaterThan(zoomed.x);
  expect(await frameSequence(page, button.id)).toBe(buttonFrames);
  await expect(page.getByText('诊断 0')).toBeVisible();
});

test('resets widget state when the mode changes', async ({ page }) => {
  await openCanvas(page);
  const segment = await demoWidget(page, 'demo:segment');
  await switchMode(page, '运行');
  // The run-mode driver keeps repainting the display.
  expect(await frameSequence(page, segment.id)).toBeGreaterThan(1);

  // Leaving run mode rebuilds every widget: the display drops its value and paints once.
  await switchMode(page, '编辑');

  expect(await frameSequence(page, segment.id)).toBe(1);
  const { document } = await sceneState(page);
  expect(await layerCount(page)).toBe(document.widgets.length);
  await expect(page.getByText('诊断 0')).toBeVisible();
});
