import type { FloatingInput, FloatingInputSample } from './types';
import { checkBoolean, checkIdentity, checkInteger, checkSupply } from './validation';

function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash;
}

function xorshift32(state: number): number {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

function mix32(value: number): number {
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

export function createFloatingInput(
  seed: number,
  instanceId: string,
  pinName: string,
): FloatingInput {
  checkInteger(seed, 0, 0xffffffff, 'seed');
  checkIdentity(instanceId, 'instanceId');
  checkIdentity(pinName, 'pinName');
  let floatingCount = 0;
  let episodeSeed = 0;
  let initialVoltage: number | undefined;
  let hasEpisode = false;

  function beginFloating(supplyVoltage?: number): void {
    if (supplyVoltage !== undefined) checkSupply(supplyVoltage);
    floatingCount = (floatingCount + 1) >>> 0;
    episodeSeed =
      hash32(JSON.stringify(['mica-floating-v2', seed, instanceId, pinName, floatingCount])) || 1;
    initialVoltage =
      supplyVoltage === undefined
        ? undefined
        : (xorshift32(episodeSeed) / 0x100000000) * supplyVoltage;
    hasEpisode = true;
  }

  function sample(supplyVoltage: number, timePs: number, enabled = true): FloatingInputSample {
    checkBoolean(enabled, 'enabled');
    if (!enabled) return Object.freeze({ state: 'disabled' });
    checkSupply(supplyVoltage);
    checkInteger(timePs, 0, 7_200_000_000_000_000, 'timePs');
    if (!hasEpisode) throw new Error('Call beginFloating before sampling');
    // Recovery must call sample at its resolution point, not at a later business read.
    if (initialVoltage === undefined) {
      initialVoltage = (xorshift32(episodeSeed) / 0x100000000) * supplyVoltage;
    }
    const low = timePs >>> 0;
    const high = Math.floor(timePs / 0x100000000);
    const randomAtTime = mix32(mix32(episodeSeed ^ low) ^ high) / 0x100000000;
    const noise = (randomAtTime * 2 - 1) * 0.1;
    return Object.freeze({
      state: 'ready',
      voltage: Math.min(supplyVoltage, Math.max(0, initialVoltage + noise)),
    });
  }

  return Object.freeze({ beginFloating, sample });
}
