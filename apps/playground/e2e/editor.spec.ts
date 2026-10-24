import { expect, test, type Page } from '@playwright/test';

/** The mounted editor the playground exposes in dev builds. */
interface EditorHandle {
  readonly canvas: HTMLCanvasElement;
  readonly controller: {
    hitTest(point: { x: number; y: number }): Hit | undefined;
    setTool(tool: string): void;
  };
  placeDevice(device: string): void;
  getViewport(): { readonly scale: number };
  setViewport(viewport: {
    readonly scale: number;
    readonly offsetX: number;
    readonly offsetY: number;
  }): void;
  toScreen(point: { x: number; y: number }): { x: number; y: number };
}

interface Hit {
  readonly kind: string;
  readonly id?: string;
  readonly symbolId?: string;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Everything the tests assert on, read straight from the live editor. */
interface Snapshot {
  readonly tool: string;
  readonly placingDevice: string | undefined;
  readonly symbols: readonly (Point & { readonly id: string })[];
  readonly wires: readonly { readonly id: string; readonly points: readonly Point[] }[];
  readonly junctions: readonly (Point & { readonly id: string })[];
  /** Host-facing inspector for the current selection; `undefined` when nothing is selected. */
  readonly inspector:
    { readonly kind: string; readonly id: string; readonly fields: number } | undefined;
}

function readSnapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const { controller } = (globalThis as unknown as { mica: EditorHandle }).mica;
    const state = (
      controller as unknown as {
        getState(): {
          tool: string;
          placingDevice: string | undefined;
          document: {
            sheet: {
              symbols: readonly (Point & { id: string })[];
              wires: readonly { id: string; points: readonly Point[] }[];
              junctions: readonly (Point & { id: string })[];
            };
          };
          inspector:
            | {
                readonly kind: 'symbol';
                readonly id: string;
                readonly properties: readonly unknown[];
              }
            | { readonly kind: 'wire'; readonly id: string; readonly points: readonly unknown[] }
            | undefined;
        };
      }
    ).getState();
    const { symbols, wires, junctions } = state.document.sheet;
    const copy = ({ x, y }: Point): Point => ({ x, y });
    const { inspector } = state;
    return {
      tool: state.tool,
      placingDevice: state.placingDevice,
      symbols: symbols.map((symbol) => ({ ...copy(symbol), id: symbol.id })),
      wires: wires.map((wire) => ({ id: wire.id, points: wire.points.map(copy) })),
      junctions: junctions.map((junction) => ({ ...copy(junction), id: junction.id })),
      inspector:
        inspector === undefined
          ? undefined
          : {
              kind: inspector.kind,
              id: inspector.id,
              fields:
                inspector.kind === 'symbol' ? inspector.properties.length : inspector.points.length,
            },
    };
  });
}

async function openEditor(page: Page, hash = '#/schematic'): Promise<void> {
  await page.goto(`/${hash}`);
  await page.waitForFunction(() => (globalThis as { mica?: unknown }).mica !== undefined);
  await expect(page.locator('canvas')).toBeVisible();
}

/** Page coordinates → absolute client coordinates, so tests can address document geometry. */
async function clientOf(page: Page, point: Point): Promise<Point> {
  return page.evaluate((target) => {
    const editor = (globalThis as unknown as { mica: EditorHandle }).mica;
    const rect = editor.canvas.getBoundingClientRect();
    const screen = editor.toScreen(target);
    return { x: rect.left + screen.x, y: rect.top + screen.y };
  }, point);
}

/** Centres `point` on the canvas at `scale`, so small glyphs are grabbable without zoom guesswork. */
async function focusOn(page: Page, point: Point, scale: number): Promise<void> {
  await page.evaluate(
    ({ target, zoom }) => {
      const editor = (globalThis as unknown as { mica: EditorHandle }).mica;
      const rect = editor.canvas.getBoundingClientRect();
      editor.setViewport({
        scale: zoom,
        offsetX: rect.width / 2 - target.x * zoom,
        offsetY: rect.height / 2 - target.y * zoom,
      });
    },
    { target: point, zoom: scale },
  );
}

/** Finds a nearby point that hit-tests to `expected`, so tests never guess glyph geometry. */
async function hitPoint(
  page: Page,
  anchor: Point,
  expected: { readonly kind: string; readonly id: string },
): Promise<Point | undefined> {
  return page.evaluate(
    ({ anchor: from, expected: want }) => {
      const editor = (globalThis as unknown as { mica: EditorHandle }).mica;
      const { controller } = editor;
      const sheet = (
        controller as unknown as {
          getDocument(): { sheet: { wires: readonly { points: readonly Point[] }[] } };
        }
      ).getDocument().sheet;
      // Wire endpoints win the hit test inside the pointer tolerance, and a drag there reshapes
      // the wire instead of moving the symbol: stay clear of every vertex.
      const clearance = 6 / editor.getViewport().scale + 2;
      const vertices = sheet.wires.flatMap((wire) => wire.points);
      for (let dx = clearance; dx <= 80; dx += 1) {
        for (const dy of [0, -2, 2, -4, 4]) {
          const point = { x: from.x + dx, y: from.y + dy };
          const hit = controller.hitTest(point);
          if (hit === undefined || hit.kind !== want.kind || hit.id !== want.id) {
            continue;
          }
          // `vertexAt` matches inside a tolerance box, so clearing either axis is enough.
          const clear = vertices.every(
            (vertex) =>
              Math.abs(vertex.x - point.x) > clearance || Math.abs(vertex.y - point.y) > clearance,
          );
          if (clear) {
            return point;
          }
        }
      }
      return undefined;
    },
    { anchor, expected },
  );
}

async function drag(page: Page, from: Point, to: Point, steps = 8): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * step) / steps,
      from.y + ((to.y - from.y) * step) / steps,
    );
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(80);
}

test('renders the sample schematic', async ({ page }) => {
  await openEditor(page);
  const snapshot = await readSnapshot(page);
  expect(snapshot.symbols.map((symbol) => symbol.id)).toEqual(
    expect.arrayContaining([
      '00000006-2dc0-44c6-8963-e4ea065d722b',
      '00000008-9054-4323-8487-62af20580a94',
      '00000005-c16f-4700-81a9-7ef80c62a850',
      '00000003-4d70-4c65-8b59-601eaeb86945',
    ]),
  );
  expect(snapshot.wires).toHaveLength(5);
  expect(snapshot.junctions).toHaveLength(1);
});

test('preselects the MCU so the host property panel has content', async ({ page }) => {
  await openEditor(page);
  const snapshot = await readSnapshot(page);
  // A stale preselect id would be pruned by the controller and leave the inspector empty.
  expect(snapshot.inspector?.kind).toBe('symbol');
  expect(snapshot.symbols.some((symbol) => symbol.id === snapshot.inspector?.id)).toBe(true);
  expect(snapshot.inspector?.fields).toBeGreaterThan(0);
});

test('dragging a net label keeps its wire connected with a fold', async ({ page }) => {
  await openEditor(page);
  const before = await readSnapshot(page);
  const label = before.symbols.find(
    (symbol) => symbol.id === '00000003-4d70-4c65-8b59-601eaeb86945',
  );
  expect(label).toBeDefined();
  const wire = before.wires.find(
    (candidate) => candidate.id === '0000000b-3b70-43f3-8425-482db6f77ef2',
  );
  expect(wire?.points).toHaveLength(2);

  // Zooming past the wire-endpoint tolerance makes the label body itself grabbable.
  await focusOn(page, label ?? { x: 0, y: 0 }, 2);
  const grab = await hitPoint(page, label ?? { x: 0, y: 0 }, {
    kind: 'symbol',
    id: '00000003-4d70-4c65-8b59-601eaeb86945',
  });
  expect(grab).toBeDefined();
  const origin = grab ?? { x: 0, y: 0 };
  await drag(
    page,
    await clientOf(page, origin),
    await clientOf(page, { x: origin.x, y: origin.y - 60 }),
  );

  const after = await readSnapshot(page);
  const moved = after.symbols.find(
    (symbol) => symbol.id === '00000003-4d70-4c65-8b59-601eaeb86945',
  );
  expect(moved?.y).toBeLessThan(label?.y ?? 0);
  // Perpendicular drag: the wire gains a fold instead of moving as a whole.
  expect(
    after.wires.find((candidate) => candidate.id === '0000000b-3b70-43f3-8425-482db6f77ef2')?.points
      .length,
  ).toBeGreaterThan(2);
  const folded = after.wires.find(
    (candidate) => candidate.id === '0000000b-3b70-43f3-8425-482db6f77ef2',
  );
  expect(folded?.points[0]).toEqual(wire?.points[0]);
  expect(folded?.points.at(-1)).toEqual({ x: moved?.x, y: moved?.y });
});

test('wire mode taps into an existing wire and creates a junction', async ({ page }) => {
  await openEditor(page);
  const tap = { x: 240, y: 470 };
  const before = await readSnapshot(page);
  const trunk = before.wires.find(
    (candidate) => candidate.id === '0000000c-804d-489f-8062-db22ac5215dc',
  );
  expect(trunk).toBeDefined();
  expect(trunk?.points.some((point) => point.y === tap.y)).toBe(true);

  await page.evaluate(() => {
    (globalThis as unknown as { mica: EditorHandle }).mica.controller.setTool('wire');
  });
  // Both offsets are page units: 3 beside the trunk snaps back onto it, 2 along it snaps onto
  // the grid, so the junction lands on the grid intersection under the trunk.
  const branch = await clientOf(page, { x: tap.x, y: tap.y + 70 });
  const end = await clientOf(page, { x: tap.x + 2, y: tap.y + 3 });
  await page.mouse.click(branch.x, branch.y);
  await page.mouse.click(end.x, end.y);
  await page.waitForTimeout(80);

  const after = await readSnapshot(page);
  expect(after.tool).toBe('select');
  expect(after.junctions).toHaveLength(before.junctions.length + 1);
  expect(after.junctions.some((junction) => junction.x === tap.x && junction.y === tap.y)).toBe(
    true,
  );
  // One new wire, plus the tapped trunk split in two.
  expect(after.wires).toHaveLength(before.wires.length + 2);
});

test('read-only editors reject every edit', async ({ page }) => {
  await openEditor(page, '#/schematic?readonly');
  const before = await readSnapshot(page);

  // Pins start wires normally; read-only only selects.
  const pin = before.wires.find((wire) => wire.id === '0000000d-84a6-479f-8077-5f49f0d1efba')
    ?.points[0] ?? { x: 0, y: 0 };
  const pinClient = await clientOf(page, pin);
  await page.mouse.click(pinClient.x, pinClient.y);
  await page.waitForTimeout(150);
  expect((await readSnapshot(page)).tool).toBe('select');

  // Hand wiring is refused too.
  await page.evaluate(() => {
    (globalThis as unknown as { mica: EditorHandle }).mica.controller.setTool('wire');
  });
  const start = await clientOf(page, { x: 240, y: 540 });
  const finish = await clientOf(page, { x: 360, y: 540 });
  await page.mouse.click(start.x, start.y);
  await page.mouse.click(finish.x, finish.y);
  await page.waitForTimeout(150);

  // Host placement is refused as well.
  await page.evaluate(() => {
    (globalThis as unknown as { mica: EditorHandle }).mica.placeDevice('at89-package:at89c52');
  });
  await page.waitForTimeout(150);

  const after = await readSnapshot(page);
  expect(after.wires).toHaveLength(before.wires.length);
  expect(after.symbols).toHaveLength(before.symbols.length);
  expect(after.placingDevice).toBeUndefined();
});
