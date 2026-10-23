import type { TimePs } from '@mica-js/core';

/** Where one trace row came from. `electrical` rows are host reads, never device publishes. */
export type TraceKind = 'publish' | 'electrical' | 'input' | 'error' | 'system';

export interface TraceEntry {
  readonly seq: number;
  readonly simTime: TimePs;
  readonly kind: TraceKind;
  readonly label: string;
  readonly detail: string;
}

export interface DiagnosticEntry {
  readonly seq: number;
  readonly code: string;
  readonly message: string;
  readonly symbol?: string;
}

/** JSON-ish payload rendering that never throws on cycles. */
export function describePayload(payload: unknown): string {
  if (payload instanceof Uint8Array) {
    return `bytes[${payload.length}] ${[...payload]
      .map((byte) => byte.toString(16).padStart(2, '0').toUpperCase())
      .join(' ')}`;
  }
  if (typeof payload === 'string') {
    return JSON.stringify(payload);
  }
  try {
    const text = JSON.stringify(payload);
    return text ?? String(payload);
  } catch {
    return String(payload);
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

/** `12000` → `"12 000 ps（12 ns）"`; keeps the raw picoseconds visible for cross-checking. */
export function formatTimePs(value: TimePs): string {
  const ps = value.toLocaleString('en-US').replace(/,/g, ' ');
  if (value === 0) {
    return '0 ps';
  }
  if (value >= 1_000_000) {
    return `${ps} ps（${formatScaled(value / 1_000_000, 'µs')}）`;
  }
  if (value >= 1_000) {
    return `${ps} ps（${formatScaled(value / 1_000, 'ns')}）`;
  }
  return `${ps} ps`;
}

function formatScaled(value: number, unit: string): string {
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace(/\.0+$/, '')} ${unit}`;
}

/**
 * Stable digest of a trace; the replay comparison uses it so the bench can show that two fresh
 * loads and runs produced the same virtual-time event sequence.
 */
export function digestTrace(
  entries: readonly TraceEntry[],
  finalTime: TimePs,
  steps: number,
): string {
  let hash = 0x811c9dc5;
  const feed = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  for (const entry of entries) {
    feed(`${entry.simTime}|${entry.kind}|${entry.label}|${entry.detail}`);
  }
  feed(`final|${finalTime}|${steps}`);
  return hash.toString(16).padStart(8, '0');
}
