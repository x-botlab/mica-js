import type { PayloadType } from '../format/type-name';
import type { TimePs } from '../scheduler/time';

/**
 * Delivery semantics of one topic port (RFC 0017).
 *
 * `level` treats the payload as the current value of the port, so only the last delivery of a step
 * takes effect; `message` treats every publish as one record that must all arrive in order.
 */
export const DELIVERY_KINDS = ['level', 'message'] as const;

export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

/** Pending `message` records a port accepts before it starts rejecting with backpressure. */
export const DEFAULT_TOPIC_CAPACITY = 64;

/** Resolves a written `delivery` value, or `undefined` when it is not one of the two kinds. */
export function parseDeliveryKind(value: unknown): DeliveryKind | undefined {
  return (DELIVERY_KINDS as readonly unknown[]).includes(value)
    ? (value as DeliveryKind)
    : undefined;
}

const DEFAULT_DELIVERY: Readonly<Record<PayloadType, DeliveryKind>> = {
  boolean: 'level',
  number: 'level',
  vec2d: 'level',
  vec3d: 'level',
  string: 'message',
  bytes: 'message',
  'bytes<rgb565>': 'message',
  'bytes<segments>': 'message',
};

/** Delivery a port gets when it omits the optional `delivery` field (RFC 0017 default table). */
export function defaultDelivery(type: PayloadType): DeliveryKind {
  return DEFAULT_DELIVERY[type];
}

/**
 * Declared delivery wins; the payload type decides when the port leaves it out.
 *
 * `declared` is `unknown` on purpose: the value arrives from a written descriptor, so an
 * unparsable value falls back to the default instead of failing here. Validating the written value
 * belongs to the loader that reads the descriptor.
 */
export function resolveDelivery(declared: unknown, type: PayloadType): DeliveryKind {
  return parseDeliveryKind(declared) ?? defaultDelivery(type);
}

/** One payload on its way to a port, with the virtual time it was published at (RFC 0017). */
export interface TopicEnvelope<T = unknown> {
  readonly payload: T;
  /** Publication time; `flushOutputs` publishes use the end of the step they ran in. */
  readonly simTime: TimePs;
}

export type TopicDeliveryDiagnosticCode = 'topic/backpressure' | 'topic/mixed-read';

/** A violation RFC 0017 reports instead of aborting the simulation. */
export interface TopicDeliveryDiagnostic {
  readonly code: TopicDeliveryDiagnosticCode;
  readonly message: string;
  readonly port?: string;
}

export interface TopicInboxOptions {
  readonly delivery: DeliveryKind;
  /** Deepest pending queue a `message` port accepts; `level` ports always hold one value. */
  readonly capacity?: number;
  /** Port name, echoed in diagnostics so a receiver can attribute them. */
  readonly port?: string;
  readonly onDiagnostic?: (diagnostic: TopicDeliveryDiagnostic) => void;
}

/**
 * Per-port delivery queue of RFC 0017.
 *
 * A step posts what the previous step published; the receiver reads it once, then `endStep()`
 * drops the step's records. `level` keeps only the newest record and remembers the effective value
 * across steps, `message` keeps every record in publish order and reports backpressure instead of
 * growing past `capacity`.
 */
export class TopicInbox<T = unknown> {
  readonly #delivery: DeliveryKind;
  readonly #capacity: number;
  readonly #port: string | undefined;
  readonly #onDiagnostic: ((diagnostic: TopicDeliveryDiagnostic) => void) | undefined;
  readonly #pending: TopicEnvelope<T>[] = [];
  #current: TopicEnvelope<T> | undefined;
  #read: 'input' | 'inputs' | undefined;
  #mixedReported = false;

  constructor(options: TopicInboxOptions) {
    this.#delivery = options.delivery;
    this.#capacity = options.capacity ?? DEFAULT_TOPIC_CAPACITY;
    this.#port = options.port;
    this.#onDiagnostic = options.onDiagnostic;
  }

  get delivery(): DeliveryKind {
    return this.#delivery;
  }

  get capacity(): number {
    return this.#capacity;
  }

  /** Records waiting for the current step. */
  get pending(): number {
    return this.#pending.length;
  }

  /** Effective value of a `level` port, including steps that received nothing. */
  get current(): T | undefined {
    return this.#current?.payload;
  }

  /**
   * Accepts one record.
   *
   * Returns `false` when a `message` port is at capacity: the record is rejected and reported, the
   * records already accepted stay untouched.
   */
  post(envelope: TopicEnvelope<T>): boolean {
    if (this.#delivery === 'level') {
      this.#pending.length = 0;
    } else if (this.#pending.length >= this.#capacity) {
      this.#report(
        'topic/backpressure',
        `Port ${JSON.stringify(this.#port ?? '')} is at its ${this.#capacity}-record capacity; a payload was rejected.`,
      );
      return false;
    }
    this.#pending.push(envelope);
    if (this.#delivery === 'level') {
      this.#current = envelope;
    }
    return true;
  }

  /** Payload the port received in this step, or `undefined` when the step was silent. */
  takeInput(): T | undefined {
    this.#markRead('input');
    return this.#pending[this.#pending.length - 1]?.payload;
  }

  /** Every record the port received in this step, in publish order. */
  takeInputs(): readonly TopicEnvelope<T>[] {
    this.#markRead('inputs');
    return this.#pending.slice();
  }

  /**
   * Ends the step: drops the records it carried and forgets which read method it used.
   *
   * A `level` value stays available through {@link current}, because the effective value outlives
   * the step that set it.
   */
  endStep(): void {
    this.#pending.length = 0;
    this.#read = undefined;
  }

  /** RFC 0017 asks for a diagnostic when one port reads with both methods. */
  #markRead(read: 'input' | 'inputs'): void {
    if (this.#read !== undefined && this.#read !== read && !this.#mixedReported) {
      this.#mixedReported = true;
      this.#report(
        'topic/mixed-read',
        `Port ${JSON.stringify(this.#port ?? '')} mixes takeInput and takeInputs; a port must use one of them.`,
      );
    }
    this.#read = read;
  }

  #report(code: TopicDeliveryDiagnosticCode, message: string): void {
    try {
      this.#onDiagnostic?.({
        code,
        message,
        ...(this.#port === undefined ? {} : { port: this.#port }),
      });
    } catch {
      // A throwing diagnostic sink must not break the delivery contract.
    }
  }
}
