import { LCD_SCREEN } from './presentation.js';

const WIDTH = 320;
const HEIGHT = 240;
const HEADER_BYTES = 8;

interface Frame {
  readonly bytes: DataView;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function readFrame(value: unknown, snapshot = false): Frame | undefined {
  if (!(value instanceof Uint8Array) || value.byteLength < HEADER_BYTES) return;
  const bytes = new DataView(value.buffer, value.byteOffset, value.byteLength);
  // getFramebuffer 的像素始终从整屏原点开始，头部 x/y 可能沿用最后一个脏矩形。
  const x = snapshot ? 0 : bytes.getUint16(0, true);
  const y = snapshot ? 0 : bytes.getUint16(2, true);
  const width = bytes.getUint16(4, true);
  const height = bytes.getUint16(6, true);
  if (
    width === 0 ||
    height === 0 ||
    x + width > WIDTH ||
    y + height > HEIGHT ||
    (snapshot && (width !== WIDTH || height !== HEIGHT)) ||
    value.byteLength !== HEADER_BYTES + width * height * 2
  ) {
    return;
  }
  return { bytes, x, y, width, height };
}

export function createLcdOverlay() {
  const surface = new OffscreenCanvas(WIDTH, HEIGHT);
  const pixels = surface.getContext('2d', { alpha: false });
  if (!pixels) throw new Error('CT117E-M4: no 2D canvas for the LCD.');

  return {
    apply({ bytes, x, y, width, height }: Frame) {
      const image = pixels.createImageData(width, height);
      const rgba = image.data;
      for (let i = 0; i < width * height; i += 1) {
        const rgb = bytes.getUint16(HEADER_BYTES + i * 2, true);
        const r = (rgb >>> 11) & 31;
        const g = (rgb >>> 5) & 63;
        const b = rgb & 31;
        rgba[i * 4] = (r << 3) | (r >>> 2);
        rgba[i * 4 + 1] = (g << 2) | (g >>> 4);
        rgba[i * 4 + 2] = (b << 3) | (b >>> 2);
        rgba[i * 4 + 3] = 255;
      }
      pixels.putImageData(image, x, y);
    },
    draw(canvas: OffscreenCanvasRenderingContext2D) {
      // 对齐 SVG 内嵌照片的玻璃内缘；调用方已把画布换成照片坐标。
      canvas.save();
      canvas.beginPath();
      canvas.roundRect(
        LCD_SCREEN.x,
        LCD_SCREEN.y,
        LCD_SCREEN.width,
        LCD_SCREEN.height,
        LCD_SCREEN.radius,
      );
      canvas.clip();
      canvas.imageSmoothingEnabled = false;
      canvas.drawImage(surface, LCD_SCREEN.x, LCD_SCREEN.y, LCD_SCREEN.width, LCD_SCREEN.height);
      canvas.restore();
    },
  };
}
