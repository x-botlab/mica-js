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
    }[];
  };
}

/** The widget host is exposed too, so a test can watch a layer repaint. */
interface HostHandle {
  readonly layers: {
    get(instanceId: string): { readonly sequence: number } | undefined;
  };
}

interface Point {
  readonly x: number;
  readonly y: number;
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

test('draws every instance of the demo document', async ({ page }) => {
  await openCanvas(page);
  const { document } = await sceneState(page);
  expect(document.widgets.map((widget) => widget.widget)).toEqual([
    'demo:image',
    'demo:segment',
    'demo:button',
  ]);
  await expect(page.getByText('诊断 0')).toBeVisible();
});

test('turns a drag into a committed placement and a document revision', async ({ page }) => {
  await openCanvas(page);
  const before = await sceneState(page);
  const button = before.document.widgets.find((widget) => widget.widget === 'demo:button');
  expect(button).toBeDefined();

  const start = await pagePoint(page, { x: (button?.x ?? 0) + 48, y: (button?.y ?? 0) + 28 });
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
  await page.getByRole('button', { name: '运行' }).click();
  await expect.poll(async () => (await sceneState(page)).mode).toBe('run');

  const button = (await sceneState(page)).document.widgets.find(
    (widget) => widget.widget === 'demo:button',
  );
  const point = await pagePoint(page, {
    x: (button?.x ?? 0) + 48,
    y: (button?.y ?? 0) + 28,
  });
  await page.mouse.click(point.x, point.y);

  await expect(page.getByText('demo-board.press').first()).toBeVisible();
  await expect(page.getByText('诊断 0')).toBeVisible();
});

test('repaints the segment from the run-mode timer', async ({ page }) => {
  await openCanvas(page);
  const segment = (await sceneState(page)).document.widgets.find(
    (widget) => widget.widget === 'demo:segment',
  );
  if (segment === undefined) {
    throw new Error('the demo document has no segment instance');
  }

  const frames = (): Promise<number> =>
    page.evaluate((instanceId) => {
      const host = (globalThis as unknown as { micaWidgetHost: HostHandle }).micaWidgetHost;
      return host.layers.get(instanceId)?.sequence ?? 0;
    }, segment.id);
  // The mount already produced one frame; the driver's deliveries have to add more.
  const mounted = await frames();
  await page.getByRole('button', { name: '运行' }).click();

  await expect.poll(frames, { timeout: 5000 }).toBeGreaterThan(mounted);
});
