import type { DevicePackageRegistration } from '@mica-js/core/schematic';

/**
 * Board-level parts the examples place directly.
 *
 * These are symbol-only devices: a schematic example only needs pin geometry, so
 * the packages stay small enough to read next to the sheet they document.
 */

/** LED with an anode and a cathode. */
export const LED_DEVICE = 'board:led';

/** Seven-segment display with one pin per segment plus a common cathode. */
export const SEVEN_SEGMENT_DEVICE = 'board:seven-segment';

/** The teaching board used by the playground demos: keys, LEDs and a rail pair. */
export const CT107D_BOARD_DEVICE = 'board:ct107d-board';

const SEGMENTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'] as const;
const KEYS = ['KEY1', 'KEY2', 'KEY3', 'KEY4'] as const;
const LEDS = ['LED1', 'LED2', 'LED3', 'LED4', 'LED5', 'LED6', 'LED7', 'LED8'] as const;

/** Symbol pin block: every pin is a signal pin drawn on `side`. */
function pins(
  names: readonly string[],
  side: 'left' | 'right' | 'top' | 'bottom',
): Readonly<Record<string, { readonly kind: 'signal'; readonly side: string }>> {
  return Object.fromEntries(names.map((name) => [name, { kind: 'signal', side }] as const));
}

/** `board` package every schematic example may place. */
export const BOARD_DEVICE_PACKAGES: readonly DevicePackageRegistration[] = Object.freeze([
  {
    packageId: 'board',
    devices: [
      {
        id: 'led',
        displayName: 'LED',
        designatorPrefix: 'D',
        raw: {
          pins: {
            A: { kind: 'signal', side: 'left' },
            K: { kind: 'signal', side: 'right' },
          },
          properties: {
            color: { type: 'color', title: '颜色', default: '#EF4444' },
          },
        },
      },
      {
        id: 'seven-segment',
        displayName: '7 段数码管',
        designatorPrefix: 'DS',
        raw: {
          pins: {
            ...pins(SEGMENTS, 'left'),
            COM: { kind: 'signal', side: 'right' },
          },
        },
      },
      {
        id: 'ct107d-board',
        displayName: 'CT107D 开发板',
        designatorPrefix: 'A',
        raw: {
          pins: {
            ...pins(KEYS, 'left'),
            ...pins(LEDS, 'right'),
            VCC: { kind: 'signal', side: 'top' },
            GND: { kind: 'signal', side: 'bottom' },
          },
        },
      },
    ],
  },
]);
