import type {} from '../device/.mica/device.d.ts';
import { describe, expect, it } from 'vitest';
import {
  FieldVersions,
  PanelSession,
  RequestEpoch,
  SerialLedger,
  callModel,
  encodeUtf8Payload,
  formatHexBytes,
  freshValue,
  hexDumpRows,
  modelUnavailableReason,
  parseBoundedNumber,
  parseHexPayload,
} from '../device/src/panel/logic.ts';
import { BoardBootstrap } from '../device/src/panel/panel.ts';
import type { SnapshotPayload } from '../device/src/panel/panel.ts';
import { toDisposable } from '@mica-js/core/lifecycle';

describe('panel UTF-8 payload', () => {
  it('counts encoded bytes rather than characters at the 64-byte boundary', () => {
    const accepted = encodeUtf8Payload(`${'中'.repeat(21)}A`);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error(accepted.message);
    expect(accepted.bytes).toHaveLength(64);

    const rejected = encodeUtf8Payload('中'.repeat(22));
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('Expected the over-limit payload to fail');
    expect(rejected.message).toContain('66 字节');
    expect(rejected.message).toContain('64');
  });

  it('accepts 64 ASCII bytes, rejects 65 and preserves whitespace', () => {
    expect(encodeUtf8Payload('A'.repeat(64)).ok).toBe(true);
    expect(encodeUtf8Payload('A'.repeat(65)).ok).toBe(false);
    const spaces = encodeUtf8Payload('  ');
    expect(spaces.ok).toBe(true);
    if (!spaces.ok) throw new Error(spaces.message);
    expect([...spaces.bytes]).toEqual([0x20, 0x20]);
    expect(encodeUtf8Payload('').ok).toBe(false);
  });
});

describe('panel hexadecimal payload', () => {
  it('parses separated and contiguous hex with optional whitespace', () => {
    const chunk = parseHexPayload('48 65 6c\n6C\t6F');
    expect(chunk.ok).toBe(true);
    if (!chunk.ok) throw new Error(chunk.message);
    expect([...chunk.bytes]).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f]);

    const contiguous = parseHexPayload('48656C6C6F');
    expect(contiguous.ok).toBe(true);
    if (!contiguous.ok) throw new Error(contiguous.message);
    expect([...contiguous.bytes]).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  });

  it('rejects prefixes, separators, odd digits and unknown characters explicitly', () => {
    const prefixed = parseHexPayload('0x41');
    expect(prefixed.ok).toBe(false);
    if (prefixed.ok) throw new Error('Expected 0x to fail');
    expect(prefixed.message).toContain('0x');

    const commas = parseHexPayload('48,65');
    expect(commas.ok).toBe(false);
    if (commas.ok) throw new Error('Expected commas to fail');
    expect(commas.message).toContain('无效');

    const odd = parseHexPayload('4');
    expect(odd.ok).toBe(false);
    if (odd.ok) throw new Error('Expected odd digits to fail');
    expect(odd.message).toContain('奇数');

    const invalid = parseHexPayload('4G');
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error('Expected an invalid digit to fail');
    expect(invalid.message).toContain('G');

    expect(parseHexPayload('   ').ok).toBe(false);
  });

  it('applies the 64-byte limit after parsing, not to the character count', () => {
    const atLimit = parseHexPayload(Array.from({ length: 64 }, () => 'A5').join(' '));
    expect(atLimit.ok).toBe(true);
    if (!atLimit.ok) throw new Error(atLimit.message);
    expect(atLimit.bytes).toHaveLength(64);

    const overLimit = parseHexPayload('00'.repeat(65));
    expect(overLimit.ok).toBe(false);
    if (overLimit.ok) throw new Error('Expected the over-limit payload to fail');
    expect(overLimit.message).toContain('65 字节');
  });
});

describe('panel bounded numbers', () => {
  it('checks finite values and closed bounds instead of clamping', () => {
    const bounds = { label: '温度', min: -55, max: 125 };
    expect(parseBoundedNumber(' 0.0625 ', bounds)).toEqual({ ok: true, value: 0.0625 });
    expect(parseBoundedNumber('-55', bounds)).toEqual({ ok: true, value: -55 });
    expect(parseBoundedNumber('125', bounds)).toEqual({ ok: true, value: 125 });

    for (const input of ['', 'abc', '126', '-55.1', 'Infinity']) {
      const parsed = parseBoundedNumber(input, bounds);
      expect(parsed.ok, input).toBe(false);
    }
    expect(parseBoundedNumber('-0', bounds)).toEqual({ ok: true, value: 0 });
  });

  it('rejects fractional integers and invalid bounds', () => {
    expect(parseBoundedNumber('1.5', { label: 'AIN', min: 0, max: 3, integer: true }).ok).toBe(
      false,
    );
    expect(parseBoundedNumber('2', { label: 'AIN', min: 0, max: 3, integer: true })).toEqual({
      ok: true,
      value: 2,
    });
    expect(() => parseBoundedNumber('1', { label: '坏区间', min: 2, max: 1 })).toThrow(RangeError);
  });
});

describe('panel serial ledger', () => {
  it('merges a late history read with live bytes and reports model drops', () => {
    const ledger = new SerialLedger(8);
    const history = ledger.ingest({
      start: 5,
      data: Uint8Array.from([5, 6, 7]),
      dropped: 5,
    });
    expect(history.appended).toEqual(Uint8Array.from([5, 6, 7]));
    expect(history.gapBytes).toBe(0);
    expect(history.droppedBytes).toBe(5);
    expect(ledger.nextCursor).toBe(8);
    expect(ledger.droppedBytes).toBe(5);

    // The buffered live event overlaps the tail of the history read.
    const live = ledger.ingest({ start: 6, data: Uint8Array.from([6, 7, 8]) });
    expect(live.duplicateBytes).toBe(2);
    expect(live.appended).toEqual(Uint8Array.from([8]));
    expect(ledger.nextCursor).toBe(9);
  });

  it('drops fully duplicated chunks and separates gaps from reported drops', () => {
    const ledger = new SerialLedger(16);
    ledger.ingest({ start: 0, data: Uint8Array.from([1, 2, 3]) });
    const duplicate = ledger.ingest({ start: 0, data: Uint8Array.from([1, 2, 3]) });
    expect(duplicate.appended).toHaveLength(0);
    expect(duplicate.duplicateBytes).toBe(3);
    expect(ledger.nextCursor).toBe(3);

    const gap = ledger.ingest({ start: 8, data: Uint8Array.from([9]), dropped: 2 });
    expect(gap.gapBytes).toBe(3);
    expect(gap.droppedBytes).toBe(2);
    expect(ledger.nextCursor).toBe(9);
    expect(ledger.gapBytes).toBe(3);
    expect(ledger.droppedBytes).toBe(2);
  });

  it('keeps buffered live data behind the initial history read for a late subscriber', () => {
    const ledger = new SerialLedger(4096);
    // The panel subscribes first and buffers this live chunk while readSerial is in flight.
    const bufferedLive = { start: 10, data: Uint8Array.from([10, 11]) };
    // The history reply starts before the live cursor and covers it. It must be ingested first.
    const history = ledger.ingest({
      start: 5,
      data: Uint8Array.from([5, 6, 7, 8, 9, 10, 11]),
      dropped: 5,
    });
    expect(history.appended).toHaveLength(7);
    expect(ledger.nextCursor).toBe(12);
    expect(ledger.droppedBytes).toBe(5);

    const live = ledger.ingest(bufferedLive);
    expect(live.appended).toHaveLength(0);
    expect(live.duplicateBytes).toBe(2);
    expect(ledger.nextCursor).toBe(12);
    expect(ledger.gapBytes).toBe(0);
  });

  it('copies appended bytes and rejects invalid cursors', () => {
    const ledger = new SerialLedger(4);
    const source = Uint8Array.from([1, 2]);
    const result = ledger.ingest({ start: 0, data: source });
    source[0] = 99;
    expect(result.appended).toEqual(Uint8Array.from([1, 2]));

    expect(() => ledger.ingest({ start: -1, data: new Uint8Array() })).toThrow(RangeError);
    expect(() => ledger.ingest({ start: 0, data: new Uint8Array(), dropped: -1 })).toThrow(
      RangeError,
    );
    expect(() => new SerialLedger(0)).toThrow(RangeError);
  });
});

function snapshot(
  overrides: {
    readonly relay?: boolean;
    readonly s9?: boolean;
    readonly amplifier?: {
      readonly position: number;
      readonly gain: number;
      readonly outputVoltage: number;
    };
  } = {},
): SnapshotPayload {
  return {
    latches: { U6: 0, U7: 0, U8: 0, U9: 0 },
    displays: { DS1: [0, 0, 0, 0], DS2: [0, 0, 0, 0] },
    leds: [],
    relay: overrides.relay ?? false,
    buzzer: false,
    hall: false,
    amplifier: overrides.amplifier ?? { position: 0, gain: 21, outputVoltage: 0 },
    switches: {
      S1: false,
      S4: false,
      S5: false,
      S6: false,
      S7: false,
      S8: false,
      S9: overrides.s9 ?? false,
      S10: false,
      S11: false,
      S12: false,
      S13: false,
      S14: false,
      S15: false,
      S16: false,
      S17: false,
      S18: false,
      S19: false,
    },
    jumpers: { J13: true, J3: true, J2: true, J2Tx: false, J5: true, J6: true },
    infrared: { LD1: false, U11: false, U20: false },
    ne555: { position: 0.5, frequency: 0, dutyCycle: 0 },
    uln2003: { mask: 0, channels: '0000000' },
    decoder: { select: -1, enabled: false, code: '--' },
    pcf8591: { channel: 0, output: 0, analog: [0, 0, 0, 0] },
    ledStates: [],
    temperature: { converted: false, value: 0 },
    lm386: { active: false },
  };
}

describe('panel bootstrap snapshot races', () => {
  it('replays relay, switch and amplifier events received while the first snapshot is in flight', () => {
    const board = new BoardBootstrap();
    const baseline = board.beginSnapshot();
    board.applySignal({ designator: 'K1', port: 'energized', value: 1 });
    board.applySignal({ designator: 'S9', port: 'pressed', value: 1 });
    board.applyAmplifier({ position: 0.75, gain: 1501, outputVoltage: 3.25 });
    expect(board.readback).toBeUndefined();

    expect(board.applySnapshot(snapshot(), baseline)).toBe(true);
    expect(board.readback).toMatchObject({
      relay: true,
      switches: { S9: true },
      amplifier: { position: 0.75, gain: 1501, outputVoltage: 3.25 },
      buzzer: false,
    });
  });

  it('keeps events that arrive after a manual refresh request older than its reply', () => {
    const board = new BoardBootstrap();
    board.applySnapshot(snapshot(), board.beginSnapshot());
    const baseline = board.beginSnapshot();
    board.applySignal({ designator: 'K1', port: 'energized', value: 1 });
    board.applySignal({ designator: 'S9', port: 'pressed', value: 1 });
    board.applyAmplifier({ position: 1, gain: 2001, outputVoltage: 5 });

    expect(board.applySnapshot(snapshot(), baseline)).toBe(true);
    expect(board.readback).toMatchObject({
      relay: true,
      switches: { S9: true },
      amplifier: { position: 1, gain: 2001, outputVoltage: 5 },
    });
  });

  it('applies a snapshot reply even when no event arrived and keeps unrelated values', () => {
    const board = new BoardBootstrap();
    const baseline = board.beginSnapshot();
    expect(board.applySnapshot(snapshot({ s9: true }), baseline)).toBe(true);
    expect(board.readback).toMatchObject({ relay: false, switches: { S9: true } });
  });

  it('tracks the J6 assembly state from its closedState signal', () => {
    const board = new BoardBootstrap();
    board.applySnapshot(snapshot(), board.beginSnapshot());
    expect(board.readback?.jumpers.J6).toBe(true);
    expect(board.applySignal({ designator: 'J6', port: 'closedState', value: 0 })).toBe(true);
    expect(board.readback?.jumpers.J6).toBe(false);
  });

  it('merges J2 row signals independently of a stale snapshot', () => {
    const board = new BoardBootstrap();
    board.applySnapshot(snapshot(), board.beginSnapshot());
    const baseline = board.beginSnapshot();

    expect(board.applySignal({ designator: 'J2', port: 'closedState1', value: 1 })).toBe(true);
    expect(board.readback?.jumpers).toMatchObject({ J2: true, J2Tx: true });
    expect(board.applySignal({ designator: 'J2', port: 'closedState2', value: 0 })).toBe(true);
    expect(board.applySnapshot(snapshot(), baseline)).toBe(true);
    expect(board.readback?.jumpers).toMatchObject({ J2: false, J2Tx: true });
  });

  it('drops buffered events and late replies after close', () => {
    const board = new BoardBootstrap();
    const baseline = board.beginSnapshot();
    board.applySignal({ designator: 'K1', port: 'energized', value: 1 });
    board.applyAmplifier({ position: 0.5, gain: 1001, outputVoltage: 2 });
    board.close();

    expect(board.applySnapshot(snapshot(), baseline)).toBe(false);
    expect(board.readback).toBeUndefined();
    expect(board.applySignal({ designator: 'S9', port: 'pressed', value: 1 })).toBe(false);
  });

  it('keeps the last local write when its request resolves before the first snapshot', () => {
    const board = new BoardBootstrap();
    const baseline = board.beginSnapshot();
    board.setAnalog(2, 0.5);
    expect(board.applySnapshot(snapshot(), baseline)).toBe(true);
    expect(board.readback?.pcf8591.analog[2]).toBe(0.5);
  });
});

describe('panel request and lifecycle boundaries', () => {
  it('returns rejected model requests as visible failures instead of swallowing them', async () => {
    const failure = new Error('temperature/invalid: outside range');
    const result = await callModel(() => Promise.reject(failure));
    expect(result).toEqual({ ok: false, message: 'temperature/invalid: outside range' });

    const accepted = await callModel(() => Promise.resolve(7));
    expect(accepted).toEqual({ ok: true, value: 7 });
  });

  it('keeps the newest refresh token and makes older replies stale', () => {
    const epoch = new RequestEpoch();
    const first = epoch.start();
    expect(epoch.isCurrent(first)).toBe(true);
    const second = epoch.start();
    expect(epoch.isCurrent(first)).toBe(false);
    expect(epoch.isCurrent(second)).toBe(true);

    epoch.invalidate();
    expect(epoch.isCurrent(second)).toBe(false);
  });

  it('merges snapshot fields per revision so events are not rolled back', () => {
    const versions = new FieldVersions();
    const baseline = versions.snapshot();
    versions.bump('switches.S9');
    expect(versions.isUnchanged('switches.S9', baseline)).toBe(false);
    expect(versions.isUnchanged('switches.S10', baseline)).toBe(true);

    // A later request starts from the new revision; only fields that changed in between stay live.
    const later = versions.snapshot();
    versions.bump('relay');
    expect(freshValue(versions, later, 'switches.S9', false, true)).toBe(true);
    expect(freshValue(versions, later, 'relay', false, true)).toBe(false);
    expect(freshValue(versions, later, 'buzzer', false, true)).toBe(true);
  });

  it('closes core subscriptions once and rejects late work through the closed bit', () => {
    const session = new PanelSession();
    let released = 0;
    session.track(toDisposable(() => (released += 1)));
    expect(session.closed).toBe(false);
    session.close();
    expect(session.closed).toBe(true);
    expect(released).toBe(1);
    session.close();
    expect(released).toBe(1);

    let late = false;
    session.track(toDisposable(() => (late = true)));
    expect(late).toBe(true);
  });

  it('releases every subscription even when one cleanup throws', () => {
    const session = new PanelSession();
    const failure = new Error('dispose failed');
    let released = false;
    session.track(
      toDisposable(() => {
        throw failure;
      }),
    );
    session.track(toDisposable(() => (released = true)));
    expect(() => session.close()).toThrow(AggregateError);
    expect(released).toBe(true);
    expect(session.closed).toBe(true);
  });
});

describe('panel model availability and formatting', () => {
  it('explains an unavailable model instead of constructing a second interface', () => {
    expect(modelUnavailableReason(undefined)).toContain('未声明运行模型');
    expect(modelUnavailableReason({})).toContain('methods');
    expect(modelUnavailableReason({ methods: {} })).toBeUndefined();
  });

  it('formats bounded hex previews and dumps without locale-dependent output', () => {
    const bytes = new Uint8Array(10).fill(0x41);
    const rows = hexDumpRows(bytes, 8);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      offset: '0000',
      hex: '41 41 41 41 41 41 41 41',
      ascii: 'AAAAAAAA',
    });
    expect(rows[1]).toMatchObject({ offset: '0008', hex: '41 41', ascii: 'AA' });
    expect(formatHexBytes(Uint8Array.from([0x00, 0xab]), 1)).toBe('00 …');
    expect(formatHexBytes(new Uint8Array())).toBe('');
  });
});
