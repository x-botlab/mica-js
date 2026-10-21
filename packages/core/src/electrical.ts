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

function validatePin(pin: unknown, path: string): asserts pin is ElectricalPinInput {
  checkRecord(pin, path, [
    'instanceId',
    'pinName',
    'powerReady',
    'mode',
    'outputEnabled',
    'pull',
    'digitalIntent',
    'voltageIntent',
    'model',
  ]);
  checkIdentity(pin.instanceId, `${path}.instanceId`);
  checkIdentity(pin.pinName, `${path}.pinName`);
  checkBoolean(pin.powerReady, `${path}.powerReady`);
  checkBoolean(pin.outputEnabled, `${path}.outputEnabled`);
  checkChoice(pin.mode, ['high-z', 'push-pull', 'open-drain', 'analog'], `${path}.mode`);
  checkChoice(pin.pull, ['none', 'up', 'down'], `${path}.pull`);
  const modelPath = `${path}.model`;
  checkRecord(pin.model, modelPath, [
    'kind',
    'minVoltage',
    'maxVoltage',
    'lowVoltage',
    'highVoltage',
  ]);
  const model = pin.model;
  checkChoice(model.kind, ['ideal-voltage'], `${modelPath}.kind`);
  checkFinite(model.minVoltage, `${modelPath}.minVoltage`);
  checkFinite(model.maxVoltage, `${modelPath}.maxVoltage`);
  if (model.minVoltage > model.maxVoltage) {
    throw new RangeError(
      `${modelPath}.minVoltage: ${model.minVoltage} must be <= maxVoltage ${model.maxVoltage}`,
    );
  }
  checkFinite(model.lowVoltage, `${modelPath}.lowVoltage`);
  checkFinite(model.highVoltage, `${modelPath}.highVoltage`);
  checkRange(model.lowVoltage, model.minVoltage, model.maxVoltage, `${modelPath}.lowVoltage`);
  checkRange(model.highVoltage, model.minVoltage, model.maxVoltage, `${modelPath}.highVoltage`);
  if (model.lowVoltage > model.highVoltage) {
    throw new RangeError(
      `${modelPath}.lowVoltage: ${model.lowVoltage} must be <= highVoltage ${model.highVoltage}`,
    );
  }
  if ('digitalIntent' in pin) checkBoolean(pin.digitalIntent, `${path}.digitalIntent`);
  if ('voltageIntent' in pin) {
    checkFinite(pin.voltageIntent, `${path}.voltageIntent`);
    checkRange(pin.voltageIntent, model.minVoltage, model.maxVoltage, `${path}.voltageIntent`);
  }
}

function snapshotNetwork(input: ElectricalNetworkInput): ElectricalNetworkInput {
  checkRecord(input, 'network', ['networkId', 'pins']);
  checkIdentity(input.networkId, 'network.networkId');
  if (!Array.isArray(input.pins)) invalidType('network.pins', input.pins, 'be an array');
  const sources = new Map<string, Set<string>>();
  const pins: ElectricalPinInput[] = [];
  for (let index = 0; index < input.pins.length; index += 1) {
    const pin: unknown = input.pins[index];
    const path = `network.pins[${index}]`;
    validatePin(pin, path);
    const names = sources.get(pin.instanceId) ?? new Set<string>();
    if (names.has(pin.pinName)) {
      invalidType(`${path}.pinName`, pin.pinName, `be unique within instance ${pin.instanceId}`);
    }
    names.add(pin.pinName);
    sources.set(pin.instanceId, names);
    pins.push(
      Object.freeze({
        instanceId: pin.instanceId,
        pinName: pin.pinName,
        powerReady: pin.powerReady,
        mode: pin.mode,
        outputEnabled: pin.outputEnabled,
        pull: pin.pull,
        ...(pin.digitalIntent === undefined ? {} : { digitalIntent: pin.digitalIntent }),
        ...(pin.voltageIntent === undefined ? {} : { voltageIntent: pin.voltageIntent }),
        model: Object.freeze({ ...pin.model }),
      }),
    );
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
      .map((contribution) => Object.freeze({ ...contribution }))
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
