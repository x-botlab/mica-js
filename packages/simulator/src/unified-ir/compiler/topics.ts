import type {
  EntryRef,
  FunctionBuilder,
  IRModule,
  OutputRef,
  ScalarType,
  Value,
} from '@mica-js/ir';
import {
  UnifiedIRCompilerError,
  type CompiledTopicPort,
  type CompiledTopics,
  type DeviceConfig,
  type DevicePortDescription,
  type DevicePortMap,
  type DevicePortPayloadType,
} from './types';

/**
 * Logical topic ports of the unified compiler (U05).
 *
 * A device declares `description.ports`; the compiler turns every port into one
 * IR endpoint:
 *
 * ```text
 * output port  ->  module.output('led1_lit', { params: ['bool'], capacity })
 * input  port  ->  module.entry ('led1_set', ['bool'])   // body = device handler
 * ```
 *
 * Payloads travel as scalars, so every payload type owns a fixed encoding (see
 * {@link topicPayloadParams}). The runtime converts between a `TopicPayload`
 * and those scalars; the compiler only needs the arity and the scalar types.
 */

/**
 * Bytes one `string` topic payload may occupy, UTF-8 encoded.
 *
 * Strings travel as `u32` words (4 bytes each) because an IR output carries
 * scalars only. The limit keeps the generated signature small; a longer payload
 * is rejected with `CircuitError('invalid-topic-payload')` instead of being
 * silently truncated.
 */
export const TOPIC_STRING_MAX_BYTES = 32;

/** Bytes one `bytes` topic payload may occupy; see {@link TOPIC_STRING_MAX_BYTES}. */
export const TOPIC_BYTES_MAX_BYTES = 32;

/** Capacity of one generated output endpoint, in queued publishes. */
export const DEFAULT_TOPIC_CAPACITY = 64;

const WORDS_PER_PAYLOAD = 4;

/** Number of `u32` words a bounded byte payload of `bytes` bytes needs. */
function wordCount(bytes: number): number {
  return Math.ceil(bytes / WORDS_PER_PAYLOAD);
}

const STRING_WORDS = wordCount(TOPIC_STRING_MAX_BYTES);
const BYTES_WORDS = wordCount(TOPIC_BYTES_MAX_BYTES);

/** `u32` words that hold a bounded byte payload; the first entry is the length. */
function bytePayloadParams(words: number): readonly ScalarType[] {
  return Object.freeze<ScalarType[]>([
    'u32',
    ...(Array.from({ length: words }, () => 'u32' as const) as ScalarType[]),
  ]);
}

const BYTE_PARAMS: readonly ScalarType[] = bytePayloadParams(BYTES_WORDS);
const STRING_PARAMS: readonly ScalarType[] = bytePayloadParams(STRING_WORDS);

const PAYLOAD_PARAMS: Readonly<Record<DevicePortPayloadType, readonly ScalarType[]>> =
  Object.freeze({
    boolean: Object.freeze<ScalarType[]>(['bool']),
    number: Object.freeze<ScalarType[]>(['f64']),
    vec2d: Object.freeze<ScalarType[]>(['f64', 'f64']),
    vec3d: Object.freeze<ScalarType[]>(['f64', 'f64', 'f64']),
    string: STRING_PARAMS,
    bytes: BYTE_PARAMS,
    'bytes<rgb565>': BYTE_PARAMS,
    'bytes<segments>': BYTE_PARAMS,
  });

/**
 * IR scalar parameters of one payload type.
 *
 * ```text
 * boolean         -> ['bool']
 * number          -> ['f64']
 * vec2d           -> ['f64', 'f64']
 * vec3d           -> ['f64', 'f64', 'f64']
 * string          -> ['u32' x 9]   length + 8 packed UTF-8 words (32 bytes)
 * bytes / bytes<*> -> ['u32' x 9]  length + 8 packed byte words (32 bytes)
 * ```
 */
export function topicPayloadParams(type: DevicePortPayloadType): readonly ScalarType[] {
  const params = PAYLOAD_PARAMS[type];
  if (params === undefined) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Unknown topic payload type ${JSON.stringify(String(type))}`,
    );
  }
  return params;
}

/** One port declared by a device, in declaration order. */
export interface DeclaredTopicPort {
  readonly deviceId: string;
  readonly port: string;
  readonly key: string;
  readonly description: DevicePortDescription;
  readonly params: readonly ScalarType[];
}

/** Iterates the ports of a description regardless of its container type. */
export function topicPortsOf(
  device: DeviceConfig,
): readonly (readonly [string, DevicePortDescription])[] {
  const ports = device.description.ports;
  if (ports === undefined) return [];
  return entriesOf(ports);
}

function entriesOf(ports: DevicePortMap): readonly (readonly [string, DevicePortDescription])[] {
  return ports instanceof Map ? [...ports.entries()] : Object.entries(ports);
}

/** `<deviceId>.<port>` — the key every topic map uses. */
export function topicKey(deviceId: string, port: string): string {
  return `${deviceId}.${port}`;
}

function assertPortName(deviceId: string, port: string): void {
  if (typeof port !== 'string' || port.length === 0) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Device "${deviceId}" declares an empty topic port name`,
      { deviceId },
    );
  }
}

/** Validates one declared port and returns its encoding. */
export function validatePort(
  deviceId: string,
  port: string,
  description: DevicePortDescription,
): readonly ScalarType[] {
  assertPortName(deviceId, port);
  if (description === null || typeof description !== 'object') {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Topic port '${topicKey(deviceId, port)}' must be an object with direction and type`,
      { deviceId },
    );
  }
  if (description.direction !== 'input' && description.direction !== 'output') {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Topic port '${topicKey(deviceId, port)}' needs direction 'input' or 'output'`,
      { deviceId },
    );
  }
  if (typeof description.type !== 'string' || !(description.type in PAYLOAD_PARAMS)) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      `Topic port '${topicKey(deviceId, port)}' has unknown payload type ${JSON.stringify(String(description.type))}; expected one of [${Object.keys(PAYLOAD_PARAMS).join(', ')}]`,
      { deviceId },
    );
  }
  return topicPayloadParams(description.type);
}

/**
 * Declares and resolves the topic endpoints of one circuit.
 *
 * The registry is filled *before* device generation (so a behaviour can write
 * its outputs and subscribe to its inputs) and finalized afterwards: every input
 * entry a device did not bind still gets a body, so delivering a payload to a
 * port nobody listens to is a no-op instead of an IR trap.
 */
export class TopicEndpointRegistry {
  readonly #module: IRModule;
  readonly #capacity: number;
  readonly #ports: DeclaredTopicPort[] = [];
  readonly #byKey = new Map<string, DeclaredTopicPort>();
  readonly #outputs = new Map<string, OutputRef>();
  readonly #entries = new Map<string, EntryRef>();
  readonly #bound = new Set<string>();

  constructor(module: IRModule, options: { readonly capacity?: number } = {}) {
    this.#module = module;
    this.#capacity = options.capacity ?? DEFAULT_TOPIC_CAPACITY;
  }

  /**
   * Declares every port of `device`.
   *
   * @throws {UnifiedIRCompilerError} for an empty name, an unknown payload type
   *   or a duplicate `<deviceId>.<port>` key.
   */
  declare(device: DeviceConfig): void {
    for (const [port, description] of topicPortsOf(device)) {
      const params = validatePort(device.id, port, description);
      const key = topicKey(device.id, port);
      if (this.#byKey.has(key)) {
        throw new UnifiedIRCompilerError('invalid-input', `Topic port '${key}' is declared twice`, {
          deviceId: device.id,
        });
      }
      const declared: DeclaredTopicPort = Object.freeze({
        deviceId: device.id,
        port,
        key,
        description,
        params,
      });
      this.#ports.push(declared);
      this.#byKey.set(key, declared);
      if (description.direction === 'output') {
        this.#outputs.set(
          key,
          this.#module.output(`${device.id}_${port}`, {
            params,
            capacity: this.#capacity,
          }),
        );
      } else {
        this.#entries.set(key, this.#module.entry(`${device.id}_${port}`, params));
      }
    }
  }

  /** The declared port named `deviceId.port`, if any. */
  port(deviceId: string, port: string): DeclaredTopicPort | undefined {
    return this.#byKey.get(topicKey(deviceId, port));
  }

  /** Output endpoint of an `output` port. */
  output(deviceId: string, port: string): OutputRef {
    const key = topicKey(deviceId, port);
    const output = this.#outputs.get(key);
    if (output === undefined) {
      throw this.#missing(deviceId, port, 'output');
    }
    return output;
  }

  /** Input entry of an `input` port. */
  entry(deviceId: string, port: string): EntryRef {
    const key = topicKey(deviceId, port);
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      throw this.#missing(deviceId, port, 'input');
    }
    return entry;
  }

  /**
   * Generates the body of one input entry from `body`.
   *
   * @throws {UnifiedIRCompilerError} when the port is not an input port or was
   *   already bound by another behaviour hook.
   */
  bind(
    deviceId: string,
    port: string,
    body: (builder: FunctionBuilder<readonly []>, params: readonly Value<ScalarType>[]) => void,
  ): void {
    const key = topicKey(deviceId, port);
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      throw this.#missing(deviceId, port, 'input');
    }
    if (this.#bound.has(key)) {
      throw new UnifiedIRCompilerError(
        'invalid-input',
        `Topic port '${key}' already has a subscriber; a port has exactly one handler`,
        { deviceId },
      );
    }
    this.#bound.add(key);
    entry.body((builder, params) => {
      body(builder, params as readonly Value<ScalarType>[]);
      builder.return([]);
    });
  }

  /**
   * Defines an empty body for every input entry no behaviour claimed and
   * returns the compiled view the runtime consumes.
   */
  finalize(): CompiledTopics {
    for (const port of this.#ports) {
      if (port.description.direction !== 'input' || this.#bound.has(port.key)) continue;
      const entry = this.#entries.get(port.key);
      entry?.body((builder) => {
        builder.return([]);
      });
    }
    const compiled = this.#ports.map((port): CompiledTopicPort =>
      Object.freeze({
        deviceId: port.deviceId,
        port: port.port,
        key: port.key,
        direction: port.description.direction,
        type: port.description.type,
        ...(port.description.title === undefined ? {} : { title: port.description.title }),
        params: port.params,
        output: this.#outputs.get(port.key),
        entry: this.#entries.get(port.key),
      }),
    );
    return Object.freeze({
      ports: Object.freeze(compiled),
      byKey: new Map(compiled.map((port) => [port.key, port] as const)),
    });
  }

  #missing(deviceId: string, port: string, direction: 'input' | 'output'): UnifiedIRCompilerError {
    const available = this.#ports
      .filter((entry) => entry.description.direction === direction)
      .map((entry) => entry.key);
    return new UnifiedIRCompilerError(
      'invalid-input',
      `Device "${deviceId}" has no ${direction} topic port "${port}". Available: [${available.join(', ')}]`,
      { deviceId },
    );
  }
}
