/**
 * CT117E-M4 的二维展示尺寸约定（RFC 0022）。
 *
 * 底图原始照片为 1024 × 768 px；器件是 `physical` 器件，几何以 mm 表达。
 * `assets/ct117e-m4.svg` 裁剪到内容区 `PHOTO_ORIGIN` 起的 941 × 712 px，照片按
 * 10 px/mm 换算（2.4" 320×240 LCD 有效宽 48.96 mm，对应照片约 491 px），因此
 * 局部 mm 坐标为 94.1 × 71.2 mm。布局表继续用照片像素撰写，绘制与指针输入在
 * 边界处换算。
 */

/** 裁剪后照片的原点在原始照片中的像素位置。 */
export const PHOTO_ORIGIN = { x: 31, y: 24 } as const;

/** 照片分辨率：10 px/mm。 */
export const PX_PER_MM = 10;

/** 裁剪后照片的像素尺寸；几何 `bounds` 与它一致。 */
export const BOARD_PIXELS = { width: 941, height: 712 } as const;

/** 器件局部 mm 尺寸，与 `geometry.json` 的 `bounds` 一致。 */
export const BOARD_SIZE_MM = {
  width: BOARD_PIXELS.width / PX_PER_MM,
  height: BOARD_PIXELS.height / PX_PER_MM,
} as const;

/** 照片像素换毫米的系数，供覆盖层画布变换使用。 */
export const MM_PER_PX = 1 / PX_PER_MM;

/** 照片像素 → 器件局部 mm（相对裁剪后的照片左上角）。 */
export function toLocalPoint(point: { readonly x: number; readonly y: number }) {
  return {
    x: (point.x - PHOTO_ORIGIN.x) / PX_PER_MM,
    y: (point.y - PHOTO_ORIGIN.y) / PX_PER_MM,
  };
}

/** 器件局部 mm → 照片像素；与 `toLocalPoint` 互逆。 */
export function toPhotoPoint(point: { readonly x: number; readonly y: number }) {
  return {
    x: point.x * PX_PER_MM + PHOTO_ORIGIN.x,
    y: point.y * PX_PER_MM + PHOTO_ORIGIN.y,
  };
}

/** LCD 玻璃内缘在照片中的像素矩形；RGB565 覆盖层按它合成。 */
export const LCD_SCREEN = Object.freeze({
  x: 220,
  y: 90,
  width: 491,
  height: 398,
  radius: 5,
});
