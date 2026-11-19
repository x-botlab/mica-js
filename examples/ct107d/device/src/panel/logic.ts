/**
 * DOM-free helpers of the CT107D HTML control panel.
 *
 * Keeping validation, serial cursors, request epochs and subscription lifetimes here lets the panel
 * itself stay a thin DOM layer, and lets the important boundaries be tested without a browser.
 */
import { DisposableStore } from '@mica-js/core/lifecycle';
import type { IDisposable } from '@mica-js/core/lifecycle';

/** The fused board's UART probe accepts one model call of at most 64 bytes. */
export const MAX_UART_BYTES = 64;

export type PayloadResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly message: string };

export interface NumberBounds {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly integer?: boolean;
}

export type NumberResult =
  { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string };

/**
 * Parses one operator-entered number and checks the model's closed bounds.
 *
 * Empty input, non-finite input and out-of-range input carry distinct messages so the panel never
 * silently clamps a value the operator did not intend.
 */
export function parseBoundedNumber(raw: string, bounds: NumberBounds): NumberResult {
  if (!Number.isFinite(bounds.min) || !Number.isFinite(bounds.max) || bounds.min > bounds.max) {
    throw new RangeError(`${bounds.label} has invalid bounds`);
  }
  const text = raw.trim();
  if (text.length === 0) return { ok: false, message: `请输入${bounds.label}` };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, message: `${bounds.label}必须是有限数值` };
  if (bounds.integer === true && !Number.isInteger(value))
    return { ok: false, message: `${bounds.label}必须是整数` };
  if (value < bounds.min || value > bounds.max) {
    return {
      ok: false,
      message: `${bounds.label}需在 ${formatBound(bounds.min)}..${formatBound(bounds.max)} 之间`,
    };
  }
  return { ok: true, value: Object.is(value, -0) ? 0 : value };
}

/** Encodes UTF-8 text and enforces the probe's byte limit after encoding, not on characters. */
export function encodeUtf8Payload(text: string): PayloadResult {
  if (text.length === 0) return { ok: false, message: '请输入要发送的文本' };
  const bytes = UTF8.encode(text);
  if (bytes.length > MAX_UART_BYTES) {
    return {
      ok: false,
      message: `UTF-8 编码后 ${bytes.length} 字节，超过单次 ${MAX_UART_BYTES} 字节上限`,
    };
  }
  return { ok: true, bytes };
}

/**
 * Parses a hexadecimal byte string.
 *
 * Whitespace only groups digits; the accepted syntax is an even number of hex digits, optionally
 * separated by whitespace. Comma separators, `0x` prefixes and odd digit counts are rejected with
 * an explicit message instead of being guessed.
 */
export function parseHexPayload(text: string): PayloadResult {
  if (text.trim().length === 0) return { ok: false, message: '请输入十六进制字节' };
  if (/0x/i.test(text)) {
    return { ok: false, message: '不支持 0x 前缀；请直接写两位十六进制，例如 48 65 6C' };
  }
  const compact = text.replace(/\s+/g, '');
  for (let index = 0; index < compact.length; index += 1) {
    const character = compact[index];
    if (character !== undefined && !HEX_DIGIT.test(character)) {
      return {
        ok: false,
        message: `第 ${index + 1} 个十六进制字符 ${JSON.stringify(character)} 无效；仅接受 0-9、A-F 和空白分隔`,
      };
    }
  }
  if (compact.length % 2 !== 0) {
    return {
      ok: false,
      message: `十六进制内容有 ${compact.length} 位；每个字节需要两位，不能为奇数`,
    };
  }
  const length = compact.length / 2;
  if (length > MAX_UART_BYTES) {
    return {
      ok: false,
      message: `解析后 ${length} 字节，超过单次 ${MAX_UART_BYTES} 字节上限`,
    };
  }
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return { ok: true, bytes };
}

/** Upper-case, space-separated byte preview; appending an ellipsis when truncated. */
export function formatHexBytes(bytes: Uint8Array, limit?: number): string {
  const count = limit === undefined ? bytes.length : Math.max(0, Math.min(limit, bytes.length));
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const byte = bytes[index];
    if (byte !== undefined) parts.push(byte.toString(16).padStart(2, '0').toUpperCase());
  }
  if (parts.length === 0) return '';
  return `${parts.join(' ')}${bytes.length > count ? ' …' : ''}`;
}

/** Printable-ASCII preview; non-printable and non-ASCII bytes become middle dots. */
export function formatAsciiPreview(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '·';
  return text;
}

export interface HexDumpRow {
  readonly address: number;
  readonly offset: string;
  readonly hex: string;
  readonly ascii: string;
}

/** Formats bytes as hexadecimal rows without depending on locale or DOM. */
export function hexDumpRows(
  bytes: Uint8Array,
  bytesPerRow = 8,
  startAddress = 0,
): readonly HexDumpRow[] {
  if (!Number.isSafeInteger(bytesPerRow) || bytesPerRow <= 0)
    throw new RangeError('bytesPerRow must be a positive safe integer');
  if (!Number.isSafeInteger(startAddress) || startAddress < 0)
    throw new RangeError('startAddress must be a nonnegative safe integer');
  const rows: HexDumpRow[] = [];
  const addressWidth =
    bytes.length === 0 ? 4 : Math.max(4, (startAddress + bytes.length - 1).toString(16).length);
  for (let offset = 0; offset < bytes.length; offset += bytesPerRow) {
    const address = startAddress + offset;
    const slice = bytes.subarray(offset, offset + bytesPerRow);
    rows.push({
      address,
      offset: address.toString(16).padStart(addressWidth, '0').toUpperCase(),
      hex: formatHexBytes(slice),
      ascii: formatAsciiPreview(slice),
    });
  }
  return rows;
}

export interface SerialChunkInput {
  readonly start: number;
  readonly data: Uint8Array;
  /** Bytes the model already dropped before this chunk, as reported by `readSerial`. */
  readonly dropped?: number;
}

export interface SerialIngest {
  readonly start: number;
  readonly end: number;
  readonly appended: Uint8Array;
  readonly duplicateBytes: number;
  readonly gapBytes: number;
  readonly droppedBytes: number;
}

/**
 * Cursor ledger that merges a late history read with live UART events.
 *
 * Both lanes carry absolute cursors. The ledger keeps only bytes after `nextCursor`, so overlapping
 * history and live payloads are delivered once. Model-reported drops and unexplained cursor jumps
 * are counted separately; neither is disguised as continuous data.
 */
export class SerialLedger {
  readonly capacity: number;
  #nextCursor = 0;
  #droppedBytes = 0;
  #gapBytes = 0;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0)
      throw new RangeError('Serial capacity must be a positive safe integer');
    this.capacity = capacity;
  }

  get nextCursor(): number {
    return this.#nextCursor;
  }

  get droppedBytes(): number {
    return this.#droppedBytes;
  }

  get gapBytes(): number {
    return this.#gapBytes;
  }

  ingest(chunk: SerialChunkInput): SerialIngest {
    const { start, data } = chunk;
    if (!Number.isSafeInteger(start) || start < 0)
      throw new RangeError('Serial chunk start must be a nonnegative safe integer');
    if (!(data instanceof Uint8Array))
      throw new TypeError('Serial chunk data must be a Uint8Array');
    const dropped = chunk.dropped ?? 0;
    if (!Number.isSafeInteger(dropped) || dropped < 0)
      throw new RangeError('Serial dropped count must be a nonnegative safe integer');
    const end = start + data.length;
    if (!Number.isSafeInteger(end)) throw new RangeError('Serial chunk end must be a safe integer');

    if (end <= this.#nextCursor) {
      return {
        start,
        end,
        appended: new Uint8Array(0),
        duplicateBytes: data.length,
        gapBytes: 0,
        droppedBytes: 0,
      };
    }

    const overlap = Math.max(0, this.#nextCursor - start);
    const missing = Math.max(0, start - this.#nextCursor);
    const gap = Math.max(0, missing - dropped);
    this.#droppedBytes += dropped;
    this.#gapBytes += gap;
    const appended = data.slice(overlap);
    this.#nextCursor = end;
    return {
      start,
      end,
      appended,
      duplicateBytes: overlap,
      gapBytes: gap,
      droppedBytes: dropped,
    };
  }
}

/**
 * Per-field revisions of a snapshot-shaped view state.
 *
 * A reply is applied field by field only when that field did not change while the request was in
 * flight. Events and local writes bump the version, so a late refresh cannot roll state back.
 */
export class FieldVersions {
  readonly #versions = new Map<string, number>();

  bump(field: string): void {
    this.#versions.set(field, (this.#versions.get(field) ?? 0) + 1);
  }

  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.#versions);
  }

  isUnchanged(field: string, baseline: ReadonlyMap<string, number>): boolean {
    return (this.#versions.get(field) ?? 0) === (baseline.get(field) ?? 0);
  }
}

/** Takes the reply only when `field` is still at the version captured when the request started. */
export function freshValue<T>(
  versions: FieldVersions,
  baseline: ReadonlyMap<string, number>,
  field: string,
  current: T,
  reply: T,
): T {
  return versions.isUnchanged(field, baseline) ? reply : current;
}

/**
 * Monotonic token for "latest request wins" user actions such as repeated status refreshes.
 *
 * A late reply compares its token with {@link isCurrent} before touching the view.
 */
export class RequestEpoch {
  #current = 0;

  start(): number {
    this.#current += 1;
    return this.#current;
  }

  isCurrent(token: number): boolean {
    return token === this.#current;
  }

  invalidate(): void {
    this.#current += 1;
  }
}

/** Lifecycle scope of one panel: core `DisposableStore` plus the closed bit async work checks. */
export class PanelSession {
  readonly disposables = new DisposableStore();
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  /** Adds a subscription; after close the store disposes it immediately. */
  track(disposable: IDisposable): void {
    this.disposables.add(disposable);
  }

  /** Disposes every subscription once. Cleanup failures propagate as core `AggregateError`. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.disposables.dispose();
  }
}

export type CallResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/** Normalizes one rejected model request into a visible failure instead of swallowing it. */
export async function callModel<T>(task: () => Promise<T>): Promise<CallResult<T>> {
  try {
    return { ok: true, value: await task() };
  } catch (cause) {
    return { ok: false, message: errorMessage(cause) };
  }
}

export interface ModelPresence {
  readonly methods?: Readonly<Record<string, unknown>> | undefined;
}

/** Explains why model-backed controls cannot be used, or returns `undefined` when they can. */
export function modelUnavailableReason(model: ModelPresence | undefined): string | undefined {
  if (model === undefined) return '此器件未声明运行模型；控制与串口不可用。';
  if (model.methods === undefined) return '模型接口缺少 methods；控制与串口不可用。';
  return undefined;
}

/** Formats a model event time for the serial log; history entries have no time. */
export function formatSimTime(ps: number | undefined): string {
  if (ps === undefined || !Number.isFinite(ps) || ps < 0) return '历史';
  return `+${(ps / 1e12).toFixed(3)} s`;
}

const UTF8 = new TextEncoder();
const HEX_DIGIT = /^[0-9a-f]$/i;

function formatBound(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}
