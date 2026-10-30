import type {
  DeviceAccessor,
  DeviceConfig,
  DeviceDescription,
  SchematicDeviceBinding,
  SchematicDeviceTopic,
} from '@mica-js/simulator';
import type { DeviceLibraryEntry, DeviceTopicContract } from './device-library';
import { MODEL_DEVICE_TYPES, describeModel } from './device-implementations';

/**
 * Runtime adapters for the device **contracts** in `public/devices`.
 *
 * JSON owns pins, properties and electrical resources; paired JS initializes capabilities and
 * builds IR hooks. The Playground supplies ordinary state layouts, not per-tick JS behavior.
 * A type without a state layout still renders in the editor, but cannot run in this host.
 *
 * Topic payloads cross the contract boundary through the generic `DeviceAccessor` state surface,
 * named by `topic.state`.
 */
export const RUNTIME_DEVICE_TYPES: readonly string[] = Object.freeze([...MODEL_DEVICE_TYPES]);

export function hasRuntimeModel(entry: DeviceLibraryEntry): boolean {
  return RUNTIME_DEVICE_TYPES.includes(entry.type);
}

/** IR description of one contract, or `undefined` when no model exists for its type. */
export function describeContract(
  entry: DeviceLibraryEntry,
  factory: NonNullable<DeviceDescription['factory']>,
): DeviceDescription | undefined {
  return describeModel(entry, factory);
}

/** One `DeviceConfig` of a contract, for hosts that build a circuit without a schematic sheet. */
export function createContractDevice(
  entry: DeviceLibraryEntry,
  instanceId: string,
  factory: NonNullable<DeviceDescription['factory']>,
): DeviceConfig | undefined {
  const description = describeContract(entry, factory);
  if (description === undefined) {
    return undefined;
  }
  return Object.freeze({
    id: instanceId,
    type: entry.type,
    description,
    ...(Object.keys(entry.config).length === 0 ? {} : { config: entry.config }),
  });
}

/**
 * Schematic-side binding of one contract.
 *
 * The sandbox guest and the tests resolve references through this single function, so a schematic
 * compiled in a worker behaves exactly like one compiled in Node. Electrical parameters come
 * from immutable instance properties; optional non-electrical config is forwarded unchanged.
 */
export function createContractBinding(
  entry: DeviceLibraryEntry,
  factory: NonNullable<DeviceDescription['factory']>,
): SchematicDeviceBinding | undefined {
  const description = describeContract(entry, factory);
  if (description === undefined) {
    return undefined;
  }
  return Object.freeze({
    type: entry.type,
    description,
    ...(Object.keys(entry.config).length === 0 ? {} : { config: entry.config }),
    topics: contractTopics(entry),
    read: (accessor: DeviceAccessor, port: string) => readContractTopic(accessor, entry, port),
    ...(entry.topics.some((topic) => topic.direction === 'input')
      ? {
          deliver: (accessor: DeviceAccessor, port: string, payload: unknown) =>
            deliverContractTopic(accessor, entry, port, payload),
        }
      : {}),
  });
}

/** Contract topics in the shape the simulator host expects. */
export function contractTopics(entry: DeviceLibraryEntry): readonly SchematicDeviceTopic[] {
  return entry.topics.map((topic) => ({
    port: topic.port,
    direction: topic.direction,
    type: topic.type,
    ...(topic.title === undefined ? {} : { title: topic.title }),
  }));
}

function topicOf(entry: DeviceLibraryEntry, port: string): DeviceTopicContract {
  const topic = entry.topics.find((candidate) => candidate.port === port);
  if (topic === undefined) {
    throw new TypeError(
      `Device ${entry.reference} declares no topic ${JSON.stringify(port)}; ports: ${entry.topics
        .map((candidate) => candidate.port)
        .join(', ')}`,
    );
  }
  return topic;
}

/** Reads one output topic through the contract's state name. */
export function readContractTopic(
  accessor: DeviceAccessor,
  entry: DeviceLibraryEntry,
  port: string,
): unknown {
  const topic = topicOf(entry, port);
  if (topic.direction !== 'output') {
    throw new TypeError(`Device ${entry.reference} topic ${JSON.stringify(port)} is not an output`);
  }
  if (topic.state === undefined) {
    throw new TypeError(
      `Device ${entry.reference} topic ${JSON.stringify(port)} has no runtime state mapping yet`,
    );
  }
  return accessor.getState(topic.state);
}

/** Writes one input topic through the contract's state name. */
export function deliverContractTopic(
  accessor: DeviceAccessor,
  entry: DeviceLibraryEntry,
  port: string,
  payload: unknown,
): void {
  const topic = topicOf(entry, port);
  if (topic.direction !== 'input') {
    throw new TypeError(`Device ${entry.reference} topic ${JSON.stringify(port)} is not an input`);
  }
  if (topic.state === undefined) {
    throw new TypeError(
      `Device ${entry.reference} topic ${JSON.stringify(port)} has no runtime state mapping yet`,
    );
  }
  if (topic.type === 'number' && (typeof payload !== 'number' || !Number.isFinite(payload)))
    throw new TypeError(`Device ${entry.reference} topic ${port} requires a finite number`);
  if (
    entry.type === 'potentiometer-ir' &&
    port === 'position' &&
    (typeof payload !== 'number' || payload < 0 || payload > 1)
  )
    throw new TypeError('Potentiometer position must be in [0, 1]');
  accessor.setState(topic.state, payload);
}
