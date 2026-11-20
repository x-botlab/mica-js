import type { Value } from '@mica-js/document/fused';
import type {
  FusedView2DFactory,
  IFusedView2DContext,
  IFusedViewInput,
} from '@mica-js/editor/fused/runtime';
import { MM_PER_PX, PHOTO_ORIGIN, toPhotoPoint } from './presentation.js';
import { createLcdOverlay, readFrame } from './view2d-lcd.js';

type Point = IFusedViewInput['position'];
type Input = Omit<IFusedViewInput, 'type'> & {
  readonly type: IFusedViewInput['type'] | 'pointercancel' | 'pointerleave';
};

const BUTTONS = [429, 485, 542, 599].map((y, index) => ({ x: 90, y, id: index + 1 }));
// 照片左下角从左到右为 LD8..LD1；掩码 bit 0 仍对应 LD1。
const LED_X = [327, 300, 273, 246, 219, 192, 165, 138];
const POTS = [
  { x: 424, label: 'R37', method: 'setPotentiometer', id: 1 },
  { x: 531, label: 'R38', method: 'setPotentiometer', id: 2 },
  { x: 640, label: 'R39', method: 'setTimerPotentiometer', id: 1 },
  { x: 749, label: 'R40', method: 'setTimerPotentiometer', id: 2 },
] as const;
type Pot = (typeof POTS)[number];
type Button = (typeof BUTTONS)[number];
type Gesture =
  | { readonly kind: 'button'; readonly button: Button }
  | { readonly kind: 'slider'; readonly pot: Pot; requested: number };

const ACCENT = '#67e8da';
const SLIDER_Y = 608;
const SLIDER_HALF_WIDTH = 65;

function buttonAt({ x, y }: Point): Button | undefined {
  return BUTTONS.find((button) => Math.abs(x - button.x) <= 29 && Math.abs(y - button.y) <= 19);
}

export function createBoardView({
  model,
  invalidate,
}: Pick<IFusedView2DContext, 'model' | 'invalidate'>) {
  let lcd: ReturnType<typeof createLcdOverlay> | undefined;
  let pendingFrames: NonNullable<ReturnType<typeof readFrame>>[] | undefined;
  let leds = 0;
  let ledRevision = 0;
  let disposed = false;
  let initialized = false;
  let gesture: Gesture | undefined;
  let openPot: Pot | undefined;
  const settings = new Map(POTS.map((pot) => [pot, { position: 0.5, applied: 0 }]));
  let request = 0;

  function call(name: string, params: Value): Promise<Value> {
    const method = model?.methods[name];
    if (!method) throw new Error(`CT117E-M4: missing model method ${name}.`);
    return method(params);
  }

  function setLeds(value: unknown): void {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xff) return;
    ledRevision += 1;
    if (value === leds) return;
    leds = value;
    invalidate();
  }

  function applyFrame(frame: NonNullable<ReturnType<typeof readFrame>>): void {
    (lcd ??= createLcdOverlay()).apply(frame);
  }

  const ledSub = model?.events['onDidLed']?.(({ value }) => {
    if (!disposed) setLeds(value);
  });
  const lcdSub = model?.events['onDidFramebuffer']?.(({ value }) => {
    if (disposed) return;
    const frame = readFrame(value);
    if (!frame) return;
    if (pendingFrames) {
      pendingFrames.push(frame);
    } else {
      applyFrame(frame);
      invalidate();
    }
  });

  async function endGesture(): Promise<void> {
    const held = gesture;
    gesture = undefined;
    if (held?.kind !== 'button') return;
    if (!disposed) invalidate();
    await call('setButton', { id: held.button.id, pressed: false });
  }

  async function setPosition(drag: Extract<Gesture, { kind: 'slider' }>, x: number): Promise<void> {
    const { pot } = drag;
    const position = Math.max(
      0,
      Math.min(1, (x - pot.x + SLIDER_HALF_WIDTH) / (2 * SLIDER_HALF_WIDTH)),
    );
    if (position === drag.requested) return;
    drag.requested = position;
    const revision = ++request;
    try {
      await call(pot.method, { id: pot.id, position });
    } catch (error) {
      if (drag.requested === position) drag.requested = NaN;
      throw error;
    }
    const setting = settings.get(pot)!;
    if (disposed || revision < setting.applied) return;
    setting.applied = revision;
    setting.position = position;
    invalidate();
  }

  return {
    async initialize() {
      if (disposed || initialized || !model) return;
      initialized = true;
      const previousLedRevision = ledRevision;
      pendingFrames = [];
      try {
        const [snapshot, mask] = await Promise.all([
          call('getFramebuffer', null),
          call('getLedState', null),
        ]);
        if (disposed) return;
        const frame = readFrame(snapshot, true);
        if (!frame) throw new Error('CT117E-M4: invalid framebuffer snapshot.');
        applyFrame(frame);
        // 快照请求在途时，保留较新的局部更新，还原未更新像素的快照初值。
        for (const update of pendingFrames) applyFrame(update);
        if (ledRevision === previousLedRevision) setLeds(mask);
        invalidate();
      } finally {
        pendingFrames = undefined;
      }
    },

    renderOverlay(canvas: OffscreenCanvasRenderingContext2D) {
      if (disposed || !model) return;
      canvas.save();
      try {
        // 布局用照片像素撰写，宿主画布是器件局部 mm；绘制前换成照片坐标。
        canvas.scale(MM_PER_PX, MM_PER_PX);
        canvas.translate(-PHOTO_ORIGIN.x, -PHOTO_ORIGIN.y);
        lcd?.draw(canvas);
        for (const [bit, x] of LED_X.entries()) {
          if ((leds & (1 << bit)) === 0) continue;
          canvas.fillStyle = '#fff6a1';
          canvas.shadowColor = '#ffce45';
          canvas.shadowBlur = 7;
          canvas.beginPath();
          canvas.roundRect(x - 4, 669, 8, 16, 2);
          canvas.fill();
        }
        canvas.shadowBlur = 0;
        if (gesture?.kind === 'button') {
          const { x, y } = gesture.button;
          canvas.fillStyle = 'rgba(103, 232, 218, 0.45)';
          canvas.strokeStyle = ACCENT;
          canvas.lineWidth = 2;
          canvas.beginPath();
          canvas.roundRect(x - 15, y - 10, 30, 20, 3);
          canvas.fill();
          canvas.stroke();
        }
        if (openPot) drawSlider(canvas, openPot, settings.get(openPot)!.position);
      } finally {
        canvas.restore();
      }
    },

    async input(event: Input) {
      if (disposed || !model) return;
      // 指针来自器件局部 mm，命中表用照片像素。
      const { type, position, button, buttons } = {
        ...event,
        position: toPhotoPoint(event.position),
      };
      if (
        type === 'pointercancel' ||
        type === 'pointerleave' ||
        (type === 'pointerup' && button === 0)
      )
        return endGesture();
      if (type === 'pointermove') {
        if (!gesture) return;
        if ((buttons & 1) === 0) return endGesture();
        if (gesture.kind === 'slider') return setPosition(gesture, position.x);
        if (buttonAt(position) !== gesture.button) return endGesture();
        return;
      }
      if (type !== 'pointerdown' || button !== 0 || gesture) return;

      const { x, y } = position;
      if (openPot && Math.abs(x - openPot.x) <= 78 && y >= 571 && y <= 621) {
        if (Math.abs(y - SLIDER_Y) <= 10 && Math.abs(x - openPot.x) <= SLIDER_HALF_WIDTH + 6) {
          gesture = { kind: 'slider', pot: openPot, requested: settings.get(openPot)!.position };
          return setPosition(gesture, x);
        }
        return;
      }
      const pot = POTS.find((entry) => Math.abs(x - entry.x) <= 43 && y >= 644 && y <= 734);
      const next = pot === openPot ? undefined : pot;
      if (next !== openPot) {
        openPot = next;
        invalidate();
      }
      const key = buttonAt(position);
      if (!key) return;
      const held = { kind: 'button', button: key } as const;
      gesture = held;
      invalidate();
      try {
        await call('setButton', { id: key.id, pressed: true });
      } catch (error) {
        if (gesture === held) {
          gesture = undefined;
          invalidate();
        }
        throw error;
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      ledSub?.dispose();
      lcdSub?.dispose();
      lcd = undefined;
      pendingFrames = undefined;
      void endGesture().catch((error: unknown) => {
        console.error('CT117E-M4 View2D: failed to release held button.', error);
      });
    },
  };
}

function drawSlider(canvas: OffscreenCanvasRenderingContext2D, pot: Pot, position: number): void {
  const { x, label } = pot;
  canvas.beginPath();
  canvas.roundRect(x - 78, 571, 156, 50, 6);
  canvas.fillStyle = '#12181d';
  canvas.fill();
  canvas.strokeStyle = '#5b6972';
  canvas.lineWidth = 1;
  canvas.stroke();

  canvas.font = '600 13px system-ui, sans-serif';
  canvas.textBaseline = 'middle';
  canvas.textAlign = 'left';
  canvas.fillStyle = ACCENT;
  canvas.fillText(label, x - SLIDER_HALF_WIDTH, 585);
  canvas.textAlign = 'right';
  canvas.fillStyle = '#e6edf1';
  canvas.fillText(`${Math.round(position * 100)}%`, x + SLIDER_HALF_WIDTH, 585);

  const left = x - SLIDER_HALF_WIDTH;
  const offset = 2 * SLIDER_HALF_WIDTH * position;
  canvas.fillStyle = '#47545e';
  canvas.fillRect(left, SLIDER_Y - 2, 2 * SLIDER_HALF_WIDTH, 4);
  canvas.fillStyle = ACCENT;
  canvas.fillRect(left, SLIDER_Y - 2, offset, 4);
  canvas.beginPath();
  canvas.arc(left + offset, SLIDER_Y, 6, 0, Math.PI * 2);
  canvas.fill();
}

const createView: FusedView2DFactory = createBoardView;
export default createView;
