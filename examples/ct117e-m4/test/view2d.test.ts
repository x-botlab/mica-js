import { fileURLToPath } from 'node:url';
import { timePs } from '@mica-js/core';
import { Emitter } from '@mica-js/core/lifecycle';
import type { Value } from '@mica-js/document/fused';
import type { ModelEvent } from '@mica-js/sdk/fused';
import { readDirectoryPackage } from '@mica-js/sdk/fused/node';
import { afterEach, expect, it, vi } from 'vitest';
import { createBoardView } from '../src/view2d';

function framebuffer(x: number, y: number, width: number, height: number, ...colors: number[]) {
  // 非零 byteOffset，确保解码从切片而不是底层缓冲区起点读取。
  const bytes = new Uint8Array(10 + width * height * 2).subarray(2);
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  [x, y, width, height, ...colors].forEach((value, i) => header.setUint16(i * 2, value, true));
  return bytes;
}

function harness() {
  const frame = new Emitter<ModelEvent<Value>>();
  const led = new Emitter<ModelEvent<Value>>();
  const invalidate = vi.fn();
  const methods = {
    getFramebuffer: vi.fn<(params: Value) => Promise<ReturnType<typeof framebuffer>>>(async () =>
      framebuffer(3, 4, 320, 240, 0x07e0),
    ),
    getLedState: vi.fn<(params: Value) => Promise<number>>(async () => 0x81),
    setButton: vi.fn<(params: Value) => Promise<null>>(async () => null),
    setPotentiometer: vi.fn<(params: Value) => Promise<null>>(async () => null),
    setTimerPotentiometer: vi.fn<(params: Value) => Promise<null>>(async () => null),
  };
  const view = createBoardView({
    model: { methods, events: { onDidLed: led.event, onDidFramebuffer: frame.event } },
    invalidate,
  });
  let sequence = 0;
  return {
    view,
    methods,
    invalidate,
    emit(target: 'lcd' | 'led', value: Value) {
      (target === 'lcd' ? frame : led).fire({ value, sequence: ++sequence, simTime: timePs(0) });
    },
  };
}

function paint(view: ReturnType<typeof createBoardView>) {
  const canvas = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    clip: vi.fn(),
    drawImage: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
  };
  view.renderOverlay(canvas as unknown as OffscreenCanvasRenderingContext2D);
  return canvas;
}

afterEach(() => vi.unstubAllGlobals());

it('releases view2d, its geometry and the original SVG with the fused package', async () => {
  const files = await readDirectoryPackage(fileURLToPath(new URL('../dist/', import.meta.url)));
  const text = async (path: string) => new TextDecoder().decode(await files.read(path));
  const manifest = JSON.parse(await text('package.json'));
  expect(manifest.view2d).toEqual({ entry: 'view2d.js', geometry: 'geometry.json' });
  const geometry = JSON.parse(await text(manifest.view2d.geometry));
  expect(geometry.bodyBounds).toEqual({ x: 0, y: 0, width: 1024, height: 768 });
  expect(geometry.bodyImage).toBe('assets/ct117e-m4.svg');
  expect(await text(geometry.bodyImage)).toContain('viewBox="0 0 1024 768"');
  const code = Buffer.from(await files.read(manifest.view2d.entry)).toString('base64');
  const { default: factory } = await import(
    /* @vite-ignore */ `data:text/javascript;base64,${code}`
  );
  expect(factory({ invalidate() {} }).renderOverlay).toBeTypeOf('function');
});

it('draws initial and dirty RGB565 frames in order, and maps LED mask bits to the photo', async () => {
  const pixels = {
    createImageData: (width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData: vi.fn(),
  };
  class Surface {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
    getContext() {
      return pixels;
    }
  }
  vi.stubGlobal('OffscreenCanvas', Surface);

  const { view, methods, emit, invalidate } = harness();
  type Snapshot = ReturnType<typeof framebuffer>;
  let resolveSnapshot!: (value: Snapshot) => void;
  methods.getFramebuffer.mockReturnValueOnce(
    new Promise<Snapshot>((resolve) => {
      resolveSnapshot = resolve;
    }),
  );
  const initial = view.initialize();
  emit('led', 0); // 同值的新事件也必须阻止旧的非零快照。
  emit('lcd', framebuffer(319, 239, 1, 1, 0xf800));
  resolveSnapshot(framebuffer(3, 4, 320, 240, 0x07e0));
  await initial;
  const [full, dirty] = pixels.putImageData.mock.calls;
  expect(full?.slice(1)).toEqual([0, 0]);
  expect(full?.[0].data.slice(0, 8)).toEqual(new Uint8ClampedArray([0, 255, 0, 255, 0, 0, 0, 255]));
  expect(dirty?.slice(1)).toEqual([319, 239]);
  expect(dirty?.[0].data).toEqual(new Uint8ClampedArray([255, 0, 0, 255]));
  const dark = paint(view);
  expect(dark.roundRect.mock.calls).toEqual([[220, 90, 491, 398, 5]]);
  expect(dark.clip).toHaveBeenCalledOnce();
  expect(dark.drawImage.mock.calls[0]?.slice(1)).toEqual([220, 90, 491, 398]);

  emit('led', 0xff);
  expect(
    paint(view)
      .roundRect.mock.calls.slice(1)
      .map(([left]) => left + 4),
  ).toEqual([327, 300, 273, 246, 219, 192, 165, 138]);
  emit('led', 0x81);
  expect(
    paint(view)
      .roundRect.mock.calls.slice(1)
      .map(([left]) => left + 4),
  ).toEqual([327, 138]);
  emit('lcd', framebuffer(318, 239, 2, 1, 0x001f, 0xffff));
  expect(pixels.putImageData.mock.lastCall?.slice(1)).toEqual([318, 239]);
  expect(pixels.putImageData.mock.lastCall?.[0].data).toEqual(
    new Uint8ClampedArray([0, 0, 255, 255, 255, 255, 255, 255]),
  );
  const before = invalidate.mock.calls.length;
  emit('lcd', framebuffer(320, 239, 1, 1, 0xffff));
  emit('lcd', framebuffer(0, 0, 1, 1).subarray(0, 8));
  expect(invalidate).toHaveBeenCalledTimes(before);
  expect(pixels.putImageData).toHaveBeenCalledTimes(3);
  view.dispose();
  emit('lcd', framebuffer(0, 0, 1, 1, 0xffff));
  emit('led', 0);
  expect(invalidate).toHaveBeenCalledTimes(before);
});

function pointer(view: ReturnType<typeof createBoardView>) {
  return (type: Parameters<typeof view.input>[0]['type'], x: number, y: number, button = 0) =>
    view.input({ type, position: { x, y }, button, buttons: type === 'pointerup' ? 0 : 1 });
}

it('hits B1–B4 at their photographed caps and releases on up, drag-out, cancel and dispose', async () => {
  const { view, methods } = harness();
  const input = pointer(view);
  await input('pointerdown', 90, 326); // RESET is not part of the overlay.
  await input('pointerdown', 90, 429, 2);
  expect(methods.setButton).not.toHaveBeenCalled();
  const yCoordinates = [429, 485, 542, 599];
  for (const [i, y] of yCoordinates.entries()) {
    await input('pointerdown', 90, y);
    expect(paint(view).roundRect.mock.calls).toEqual([[75, y - 10, 30, 20, 3]]);
    if (i === 0) await input('pointerup', 90, y);
    if (i === 1) await input('pointermove', 200, y);
    if (i === 2) await input('pointercancel', 90, y);
    if (i === 3) view.dispose();
    expect(paint(view).roundRect).not.toHaveBeenCalled();
  }
  expect(methods.setButton.mock.calls.flat()).toEqual(
    [1, 2, 3, 4].flatMap((id) => [
      { id, pressed: true },
      { id, pressed: false },
    ]),
  );
});

it('opens one slider at a time and routes the four trimmers to the two analog and two timer inputs', async () => {
  const { view, methods } = harness();
  const input = pointer(view);
  for (const [i, x] of [424, 531, 640, 749].entries()) {
    await input('pointerdown', x, 700);
    await input('pointerup', x, 700);
    expect(paint(view).fillText.mock.calls.map(([label]) => label)).toEqual([`R${37 + i}`, '50%']);
    await input('pointerdown', x - 32.5, 608);
    await input('pointermove', x + 100, 608);
    await input('pointermove', x + 101, 608);
    await input('pointerup', x + 100, 608);
    expect(paint(view).fillText.mock.calls.at(-1)?.[0]).toBe('100%');
  }
  const expected = [1, 2].flatMap((id) => [
    { id, position: 0.25 },
    { id, position: 1 },
  ]);
  expect(methods.setPotentiometer.mock.calls.flat()).toEqual(expected);
  expect(methods.setTimerPotentiometer.mock.calls.flat()).toEqual(expected);
  await input('pointerdown', 749, 700);
  expect(paint(view).fillText).not.toHaveBeenCalled();
  view.dispose();
});
