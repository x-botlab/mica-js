import { expect, test, type Page } from '@playwright/test';

interface Point {
  readonly x: number;
  readonly y: number;
}

interface EditorHandle {
  readonly canvas: HTMLCanvasElement;
  readonly controller: {
    getState(): {
      readonly tool: string;
      readonly document: {
        readonly sheet: {
          readonly symbols: readonly (Point & { readonly id: string })[];
          readonly wires: readonly { readonly id: string; readonly points: readonly Point[] }[];
        };
      };
    };
    setTool(tool: string): void;
  };
  placeDevice(device: string): void;
  toScreen(point: Point): Point;
}

interface Snapshot {
  readonly tool: string;
  readonly symbols: readonly (Point & { readonly id: string })[];
  readonly wires: readonly { readonly id: string; readonly points: readonly Point[] }[];
}

function readSnapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const { controller } = (globalThis as unknown as { mica: EditorHandle }).mica;
    const state = controller.getState();
    const copy = ({ x, y }: Point): Point => ({ x, y });
    return {
      tool: state.tool,
      symbols: state.document.sheet.symbols.map((symbol) => ({
        ...copy(symbol),
        id: symbol.id,
      })),
      wires: state.document.sheet.wires.map((wire) => ({
        id: wire.id,
        points: wire.points.map(copy),
      })),
    };
  });
}

async function openEditor(page: Page, path = '/examples/led-blink'): Promise<void> {
  await page.goto(`/#${path}`);
  await page.waitForFunction(() => (globalThis as { mica?: unknown }).mica !== undefined);
  await expect(page.locator('canvas')).toBeVisible();
}

/** Page coordinates for a document point, so tests address geometry, not screen pixels. */
async function clientOf(page: Page, point: Point): Promise<Point> {
  return page.evaluate((target) => {
    const editor = (globalThis as unknown as { mica: EditorHandle }).mica;
    const rect = editor.canvas.getBoundingClientRect();
    const screen = editor.toScreen(target);
    return { x: rect.left + screen.x, y: rect.top + screen.y };
  }, point);
}

/** Finds a point inside a symbol body, so a drag never starts on a wire vertex. */
async function bodyPoint(
  page: Page,
  symbol: { readonly id: string } & Point,
): Promise<Point | undefined> {
  return page.evaluate((target) => {
    const { controller } = (globalThis as unknown as { mica: EditorHandle }).mica;
    for (let dx = -24; dx <= 24; dx += 2) {
      for (let dy = -24; dy <= 24; dy += 2) {
        const point = { x: target.x + dx, y: target.y + dy };
        const hit = (
          controller as unknown as {
            hitTest(point: Point): { readonly kind: string; readonly id?: string } | undefined;
          }
        ).hitTest(point);
        if (hit?.kind === 'symbol' && hit.id === target.id) {
          return point;
        }
      }
    }
    return undefined;
  }, symbol);
}

async function drag(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(80);
}

test('renders every schematic example', async ({ page }) => {
  const examples = [
    { path: '/examples/led-blink', id: 'led-blink', symbols: 3, wires: 2 },
  ] as const;

  for (const example of examples) {
    await openEditor(page, example.path);
    await expect(page.locator(`[data-example="${example.id}"]`)).toBeVisible();
    const snapshot = await readSnapshot(page);
    expect(snapshot.symbols, example.path).toHaveLength(example.symbols);
    expect(snapshot.wires, example.path).toHaveLength(example.wires);
  }
});

test('dragging a symbol commits a move', async ({ page }) => {
  await openEditor(page);
  const before = await readSnapshot(page);
  const symbol = before.symbols[0];
  expect(symbol).toBeDefined();
  if (symbol === undefined) {
    return;
  }
  const grab = await bodyPoint(page, symbol);
  expect(grab).toBeDefined();
  const origin = grab ?? symbol;
  await drag(
    page,
    await clientOf(page, origin),
    await clientOf(page, { x: origin.x + 80, y: origin.y }),
  );

  const after = await readSnapshot(page);
  const moved = after.symbols.find((candidate) => candidate.id === symbol.id);
  expect(moved?.x).toBeGreaterThan(symbol.x + 40);
});

test('navigates from the sidebar to every example', async ({ page }) => {
  await page.goto('/#/');
  for (const title of ['LED 闪烁', '基础 Widget', '简单画布']) {
    await page.getByRole('button', { name: title, exact: true }).click();
    await expect(page.locator(`[data-example]`)).toBeVisible();
  }
});

test('the read-only toggle rejects host placement', async ({ page }) => {
  await openEditor(page);
  await page.getByLabel('只读').check();
  await page.waitForTimeout(150);
  const before = await readSnapshot(page);

  await page.evaluate(() => {
    const editor = (globalThis as unknown as { mica: EditorHandle }).mica;
    try {
      editor.placeDevice('board:led');
    } catch {
      // A read-only editor refuses placement; the click below must then be ignored too.
    }
  });
  const empty = await clientOf(page, { x: 160, y: 540 });
  await page.mouse.click(empty.x, empty.y);
  await page.waitForTimeout(150);

  const after = await readSnapshot(page);
  expect(after.symbols).toHaveLength(before.symbols.length);
});

test('collapses and expands sidebar categories', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.getByRole('button', { name: 'LED 闪烁' })).toBeVisible();
  await page.getByRole('button', { name: '编辑器示例' }).click();
  await expect(page.getByRole('button', { name: 'LED 闪烁' })).toHaveCount(0);
  await page.getByRole('button', { name: '编辑器示例' }).click();
  await expect(page.getByRole('button', { name: 'LED 闪烁' })).toBeVisible();
});

test('keeps the dark mode toggle working', async ({ page }) => {
  await openEditor(page);
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: '切换到浅色' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
});
