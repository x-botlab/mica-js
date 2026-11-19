import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { DeclarationIR } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';
import { SERIAL_CAPACITY, SerialLog } from '../../shared/serial.ts';

/**
 * UART observation channel capacity must stay equal to the SerialLog window.
 *
 * The DDL cannot import TypeScript, so this test is the drift guard: both source
 * channels use one-byte messages and must retain exactly SERIAL_CAPACITY messages.
 * Overflow is explicit (`Overflow.error`); a single sync batch beyond the window is
 * never silently truncated before the adapter can account for it.
 */

const DEVICE_ROOT = join(import.meta.dirname, '..', '..');

type Channel = Extract<DeclarationIR, { kind: 'channel' }>;

function channelOf(model: Awaited<ReturnType<typeof compileDDL>>, name: string): Channel {
  const declaration = model.declarations.find(
    (entry): entry is Channel => entry.kind === 'channel' && entry.name === name,
  );

  if (declaration === undefined) throw new Error(`missing output channel ${name}`);

  return declaration;
}

function capacityOf(channel: Channel): number {
  const constant = channel.capacity.body.operations.find(
    (operation) => operation.kind === 'constant',
  );

  if (constant?.kind !== 'constant' || constant.constant.kind !== 'number')
    throw new Error(`${channel.name}: capacity is not a numeric constant`);

  return constant.constant.value;
}

function overflowOf(channel: Channel): string {
  const overflow = channel.overflow?.body.operations.find(
    (operation) => operation.kind === 'constant',
  );

  if (overflow?.kind !== 'constant' || overflow.constant.kind !== 'enum')
    throw new Error(`${channel.name}: overflow is not an enum constant`);

  return overflow.constant.member;
}

describe('UART observation capacity contract', () => {
  it('MCU uart1Tx/uart1Rx and probe tx/rx equal the SerialLog window', async () => {
    for (const [device, channels] of [
      ['iap15f2k61s2', ['uart1Tx', 'uart1Rx']],
      ['uart-probe', ['tx', 'rx']],
    ] as const) {
      const model = await compileDDL(
        readFileSync(join(DEVICE_ROOT, device, 'src', 'model.ddl'), 'utf8'),
        { uri: `mica:devices/${device}/model.ddl` },
      );

      for (const name of channels) {
        const channel = channelOf(model, name);

        expect(capacityOf(channel), `${device}.${name}`).toBe(SERIAL_CAPACITY);
        expect(overflowOf(channel), `${device}.${name}`).toBe('error');
      }
    }
  });

  it('SerialLog default capacity is the same source constant', () => {
    const log = new SerialLog();

    expect(log.status()).toEqual({
      capacity: SERIAL_CAPACITY,
      oldest: 0,
      next: 0,
      droppedTotal: 0,
    });
  });
});
