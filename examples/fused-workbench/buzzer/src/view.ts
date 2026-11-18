import type { IFusedAudio } from '@mica-js/editor/fused/runtime';

interface IBuzzerViewContext {
  readonly audio: IFusedAudio;
  readonly model: DeviceClient | undefined;
  invalidate(): void;
}

export default function createView(context: IBuzzerViewContext) {
  let active = false;
  const tone = context.audio.tone({ frequency: 2000, type: 'square', volume: 0 });
  function update(value: boolean): void {
    active = value;
    tone.set({ volume: active ? 0.06 : 0 }, { rampMs: 5 });
    context.invalidate();
  }
  const subscription = context.model?.events.onDidActiveChange((event) => update(event.value));
  return {
    async initialize() {
      update((await context.model?.methods.getActive(null)) ?? false);
    },
    renderOverlay(canvas: OffscreenCanvasRenderingContext2D) {
      if (!active) return;
      canvas.strokeStyle = '#f6cc68';
      canvas.lineWidth = 0.4;
      canvas.beginPath();
      canvas.arc(5, 4, 2.4, -0.8, 0.8);
      canvas.stroke();
    },
    dispose() {
      subscription?.dispose();
      tone.stop();
    },
  };
}
