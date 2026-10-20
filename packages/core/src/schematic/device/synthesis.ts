import type { Rect } from '../format/types';
import type { DeviceSymbolDefinition, PinAnchor, PinSide } from './symbol';

/** Pin declaration subset used for symbol synthesis (see #11 / #12). */
export interface DevicePinDeclaration {
  /** Display side; pins without a side are drawn on the left. */
  readonly side?: PinSide;
}

export interface SymbolSynthesisOptions {
  /** Distance between pin rows, in page units. Defaults to 10. */
  readonly pinPitch?: number;
  /** Stub length outside the body. Defaults to 10. */
  readonly stubLength?: number;
  /** Minimum body width. Defaults to 60. */
  readonly minWidth?: number;
  /** Minimum body height. Defaults to 40. */
  readonly minHeight?: number;
  /** Horizontal padding between the body edge and pin labels. Defaults to 10. */
  readonly horizontalPadding?: number;
  /** Vertical padding above the first and below the last pin row. Defaults to 10. */
  readonly verticalPadding?: number;
  /** Approximate glyph width of the device name. Defaults to 6.5. */
  readonly characterWidth?: number;
  /** Approximate glyph width of a pin name. Defaults to 5. */
  readonly labelCharacterWidth?: number;
  /** Inset of a top/bottom pin label from the body edge. Defaults to 10. */
  readonly labelInset?: number;
}

export interface SymbolSynthesisInput {
  readonly name: string;
  readonly pins: Readonly<Record<string, DevicePinDeclaration>>;
}

const DEFAULT_PIN_SIDE: PinSide = 'left';

/** Half height of a centred glyph box, in `characterWidth` units. */
const NAME_HALF_EXTENT = 1;

/**
 * Derives symbol geometry from pin declarations: no coordinates or body size are authored.
 * Pins keep their declaration order within a side and snap to `pinPitch`.
 */
export function synthesizeDeviceSymbol(
  input: SymbolSynthesisInput,
  options: SymbolSynthesisOptions = {},
): DeviceSymbolDefinition {
  const pinPitch = options.pinPitch ?? 10;
  const stubLength = options.stubLength ?? 10;
  const minWidth = options.minWidth ?? 60;
  const minHeight = options.minHeight ?? 40;
  const horizontalPadding = options.horizontalPadding ?? 10;
  const verticalPadding = options.verticalPadding ?? 10;
  const characterWidth = options.characterWidth ?? 6.5;
  const labelCharacterWidth = options.labelCharacterWidth ?? 5;
  const labelInset = options.labelInset ?? 10;

  const sides: Record<PinSide, string[]> = { left: [], right: [], top: [], bottom: [] };
  for (const [pinId, declaration] of Object.entries(input.pins)) {
    sides[declaration.side ?? DEFAULT_PIN_SIDE].push(pinId);
  }

  const rows = Math.max(sides.left.length, sides.right.length);
  const columns = Math.max(sides.top.length, sides.bottom.length);
  const height = Math.max(
    minHeight,
    verticalPadding * 2 + Math.max(rows - 1, 0) * pinPitch + pinPitch,
    // Rotated top/bottom labels must clear the centred device name.
    2 *
      (NAME_HALF_EXTENT * characterWidth +
        pinPitch / 2 +
        labelInset +
        rotatedHalf(sides, labelCharacterWidth)),
  );
  const width = Math.max(
    minWidth,
    horizontalPadding * 2 + Math.max(columns - 1, 0) * pinPitch + pinPitch,
  );

  const leftText = longest(sides.left);
  const rightText = longest(sides.right);
  const contentWidth =
    (leftText + rightText) * labelCharacterWidth +
    input.name.length * characterWidth +
    horizontalPadding * 3;
  const bodyWidth = Math.ceil(Math.max(width, contentWidth) / pinPitch) * pinPitch;
  const bodyHeight = Math.ceil(height / pinPitch) * pinPitch;

  const body: Rect = {
    x: -bodyWidth / 2,
    y: -bodyHeight / 2,
    width: bodyWidth,
    height: bodyHeight,
  };

  const pins: Record<string, PinAnchor> = Object.create(null);

  const placeVertical = (pinIds: readonly string[], side: 'left' | 'right'): void => {
    const start = -((pinIds.length - 1) * pinPitch) / 2;
    pinIds.forEach((pinId, index) => {
      const y = start + index * pinPitch;
      const x = side === 'left' ? body.x - stubLength : body.x + body.width + stubLength;
      pins[pinId] = { x, y, side };
    });
  };
  placeVertical(sides.left, 'left');
  placeVertical(sides.right, 'right');

  const placeHorizontal = (pinIds: readonly string[], side: 'top' | 'bottom'): void => {
    const start = -((pinIds.length - 1) * pinPitch) / 2;
    pinIds.forEach((pinId, index) => {
      const x = start + index * pinPitch;
      const y = side === 'top' ? body.y - stubLength : body.y + body.height + stubLength;
      pins[pinId] = { x, y, side };
    });
  };
  placeHorizontal(sides.top, 'top');
  placeHorizontal(sides.bottom, 'bottom');

  return { name: input.name, pins, bounds: body };
}

function longest(pinIds: readonly string[]): number {
  return pinIds.reduce((max, pinId) => Math.max(max, pinId.length), 0);
}

function rotatedHalf(
  sides: Readonly<Record<PinSide, readonly string[]>>,
  characterWidth: number,
): number {
  return (Math.max(longest(sides.top), longest(sides.bottom)) * characterWidth) / 2;
}
