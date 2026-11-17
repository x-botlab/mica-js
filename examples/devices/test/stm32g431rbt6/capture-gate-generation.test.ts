import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { timerCaptureGateDescriptors } from '@mica-js/stm32g431rbt6-core/tim';
import {
  CAPTURE_GATE_MARKERS,
  LOCAL_CAPTURE_PINS,
  renderCaptureGates,
} from '../../../stm32g431rbt6-core/scripts/render-capture-gates';

const TEST_DIR = import.meta.dirname;
const RENDER_COMMAND = 'node examples/stm32g431rbt6-core/scripts/render-capture-gates.ts';

function generatedBlock(source: string, label: string): string {
  const begin = source.indexOf(CAPTURE_GATE_MARKERS.begin);
  const end = source.indexOf(CAPTURE_GATE_MARKERS.end);

  if (begin < 0 || end < begin)
    throw new Error(
      `${label}: missing generated capture-gate markers around captureArmed; ` +
        `run \`${RENDER_COMMAND}\` and replace the marker region in the DDL`,
    );

  return source.slice(begin, end + CAPTURE_GATE_MARKERS.end.length);
}

const DDL_CONSUMERS = [
  {
    label: 'devices/stm32g431rbt6',
    path: join(TEST_DIR, '..', '..', 'stm32g431rbt6', 'src', 'model.ddl'),
  },
  {
    label: 'ct117e-m4',
    path: join(TEST_DIR, '..', '..', '..', 'ct117e-m4', 'src', 'model.ddl'),
  },
] as const;

describe('TIM capture gate renderer', () => {
  const expected = renderCaptureGates(timerCaptureGateDescriptors());

  it('maps local pinId 0/1 by pinName, not global descriptor pinId', () => {
    expect(LOCAL_CAPTURE_PINS).toEqual(['PA15', 'PB4']);
    expect(expected).toContain('if pinId == 0');
    expect(expected).toContain('} else if pinId == 1');
    expect(expected).toContain('load32le(tim, 0x48 + 0x00)');
    expect(expected).toContain('load32le(tim, 0x90 + 0x00)');
    expect(expected).toContain('gpioAfr10 >> 28');
    expect(expected).toContain('gpioAfr01 >> 16');

    // 反转 descriptor 顺序仍应得到同一文本：renderer 不依赖全局 pinId/顺序。
    expect(renderCaptureGates([...timerCaptureGateDescriptors()].reverse())).toBe(expected);
  });

  it('renders the checked-in DDL fragment', () => {
    expect(expected).toMatchSnapshot();
  });

  for (const consumer of DDL_CONSUMERS)
    it(`freshness: ${consumer.label} captureArmed block`, () => {
      const source = readFileSync(consumer.path, 'utf8');

      expect(generatedBlock(source, consumer.label)).toBe(expected);
    });
});
