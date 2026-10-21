import type {
  ElectricalContribution,
  ElectricalNetworkInput,
  ElectricalNetworkResult,
  ElectricalPinInput,
} from './electrical-types';
import {
  checkBoolean,
  checkChoice,
  checkFinite,
  checkIdentity,
  checkRange,
  checkRecord,
  invalidType,
} from './electrical-validation';

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSources(
  left: Pick<ElectricalPinInput, 'instanceId' | 'pinName'>,
  right: Pick<ElectricalPinInput, 'instanceId' | 'pinName'>,
): number {
  return compareText(left.instanceId, right.instanceId) || compareText(left.pinName, right.pinName);
}

const PIN_FIELDS = [
  'instanceId',
  'pinName',
  'powerReady',
  'mode',
  'outputEnabled',
  'pull',
  'digitalIntent',
  'voltageIntent',
  'model',
] as const;
const MODEL_FIELDS = ['kind', 'minVoltage', 'maxVoltage', 'lowVoltage', 'highVoltage'] as const;
const PIN_MODES = ['high-z', 'push-pull', 'open-drain', 'analog'] as const;
const PULLS = ['none', 'up', 'down'] as const;
const VOLTAGE_MODELS = ['ideal-voltage'] as const;

function snapshotModel(value: unknown, path: string): ElectricalPinInput['model'] {
  checkRecord(value, path, MODEL_FIELDS);
  const kind = checkChoice(value.kind, VOLTAGE_MODELS, `${path}.kind`);
  const minVoltage = value.minVoltage;
  const maxVoltage = value.maxVoltage;
  const lowVoltage = value.lowVoltage;
  const highVoltage = value.highVoltage;
  checkFinite(minVoltage, `${path}.minVoltage`);
  checkFinite(maxVoltage, `${path}.maxVoltage`);
  if (minVoltage > maxVoltage) {
    throw new RangeError(`${path}.minVoltage: ${minVoltage} must be <= maxVoltage ${maxVoltage}`);
  }
  checkFinite(lowVoltage, `${path}.lowVoltage`);
  checkFinite(highVoltage, `${path}.highVoltage`);
  checkRange(lowVoltage, minVoltage, maxVoltage, `${path}.lowVoltage`);
  checkRange(highVoltage, minVoltage, maxVoltage, `${path}.highVoltage`);
  if (lowVoltage > highVoltage) {
    throw new RangeError(`${path}.lowVoltage: ${lowVoltage} must be <= highVoltage ${highVoltage}`);
  }
  return Object.freeze({ kind, minVoltage, maxVoltage, lowVoltage, highVoltage });
}

/** Internal value capture shared with the topology layer; not exported from the package root. */
export function snapshotElectricalPin(value: unknown, path: string): ElectricalPinInput {
  checkRecord(value, path, PIN_FIELDS);
  // Read every field exactly once; the frozen snapshot below is the only value
  // later evaluation sees, including for models supplied through getters or prototypes.
  const instanceId = value.instanceId;
  const pinName = value.pinName;
  const powerReady = value.powerReady;
  const outputEnabled = value.outputEnabled;
  const mode = checkChoice(value.mode, PIN_MODES, `${path}.mode`);
  const pull = checkChoice(value.pull, PULLS, `${path}.pull`);
  checkIdentity(instanceId, `${path}.instanceId`);
  checkIdentity(pinName, `${path}.pinName`);
  checkBoolean(powerReady, `${path}.powerReady`);
  checkBoolean(outputEnabled, `${path}.outputEnabled`);
  const model = snapshotModel(value.model, `${path}.model`);
  let digitalIntent: boolean | undefined;
  if ('digitalIntent' in value) {
    const candidate = value.digitalIntent;
    checkBoolean(candidate, `${path}.digitalIntent`);
    digitalIntent = candidate;
  }
  let voltageIntent: number | undefined;
  if ('voltageIntent' in value) {
    const candidate = value.voltageIntent;
    checkFinite(candidate, `${path}.voltageIntent`);
    checkRange(candidate, model.minVoltage, model.maxVoltage, `${path}.voltageIntent`);
    voltageIntent = candidate;
  }
  return Object.freeze({
    instanceId,
    pinName,
    powerReady,
    mode,
    outputEnabled,
    pull,
    ...(digitalIntent === undefined ? {} : { digitalIntent }),
    ...(voltageIntent === undefined ? {} : { voltageIntent }),
    model,
  });
}

function snapshotNetwork(input: ElectricalNetworkInput): ElectricalNetworkInput {
  checkRecord(input, 'network', ['networkId', 'pins']);
  checkIdentity(input.networkId, 'network.networkId');
  if (!Array.isArray(input.pins)) invalidType('network.pins', input.pins, 'be an array');
  const sources = new Map<string, Set<string>>();
  const pins: ElectricalPinInput[] = [];
  for (let index = 0; index < input.pins.length; index += 1) {
    const path = `network.pins[${index}]`;
    const pin = snapshotElectricalPin(input.pins[index], path);
    const names = sources.get(pin.instanceId) ?? new Set<string>();
    if (names.has(pin.pinName)) {
      invalidType(`${path}.pinName`, pin.pinName, `be unique within instance ${pin.instanceId}`);
    }
    names.add(pin.pinName);
    sources.set(pin.instanceId, names);
    pins.push(pin);
  }
  return Object.freeze({
    networkId: input.networkId,
    pins: Object.freeze(pins.sort(compareSources)),
  });
}

function snapshotContributions(
  contributions: readonly ElectricalContribution[],
): readonly ElectricalContribution[] {
  return Object.freeze(
    contributions
      .map((contribution) =>
        Object.freeze({
          instanceId: contribution.instanceId,
          pinName: contribution.pinName,
          kind: contribution.kind,
          strength: contribution.strength,
          voltage: contribution.voltage,
        }),
      )
      .sort((left, right) => compareSources(left, right) || compareText(left.kind, right.kind)),
  );
}

export class ElectricalConflictError extends Error {
  override readonly name = 'ElectricalConflictError' as const;
  readonly network: ElectricalNetworkInput;
  readonly contributions: readonly ElectricalContribution[];

  constructor(network: ElectricalNetworkInput, contributions: readonly ElectricalContribution[]) {
    super(`Network ${network.networkId}: highest-priority voltage spread must be <= 0.001 V`);
    this.network = snapshotNetwork(network);
    this.contributions = snapshotContributions(contributions);
    Object.freeze(this);
  }
}

function activeVoltage(pin: ElectricalPinInput): number | undefined {
  if (!pin.outputEnabled) return undefined;
  switch (pin.mode) {
    case 'high-z':
      return undefined;
    case 'push-pull':
      return pin.digitalIntent === undefined
        ? undefined
        : pin.digitalIntent
          ? pin.model.highVoltage
          : pin.model.lowVoltage;
    case 'open-drain':
      return pin.digitalIntent === false ? pin.model.lowVoltage : undefined;
    case 'analog':
      return pin.voltageIntent;
  }
}

export function resolveElectricalNetwork(input: ElectricalNetworkInput): ElectricalNetworkResult {
  // Validate the complete snapshot before releasing or selecting any contribution.
  const network = snapshotNetwork(input);
  const contributions: ElectricalContribution[] = [];
  for (const pin of network.pins) {
    if (!pin.powerReady) continue;
    const source = { instanceId: pin.instanceId, pinName: pin.pinName };
    const voltage = activeVoltage(pin);
    if (voltage !== undefined) {
      contributions.push({ ...source, kind: 'drive', strength: 'strong', voltage });
    }
    if (pin.pull !== 'none') {
      contributions.push({
        ...source,
        kind: 'pull',
        strength: 'weak',
        voltage: pin.pull === 'up' ? pin.model.highVoltage : pin.model.lowVoltage,
      });
    }
  }
  const snapshot = snapshotContributions(contributions);
  if (snapshot.length === 0) {
    return Object.freeze({ state: 'floating', digitalFallback: false, contributions: snapshot });
  }
  const strength = snapshot.some((contribution) => contribution.strength === 'strong')
    ? 'strong'
    : 'weak';
  let min = Infinity;
  let max = -Infinity;
  for (const contribution of snapshot) {
    if (contribution.strength !== strength) continue;
    min = Math.min(min, contribution.voltage);
    max = Math.max(max, contribution.voltage);
  }
  if (max - min > 0.001) throw new ElectricalConflictError(network, snapshot);
  return Object.freeze({ state: 'driven', voltage: min, strength, contributions: snapshot });
}
