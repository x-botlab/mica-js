import type { DeviceDescription, DeviceStateDescription } from '@mica-js/simulator';
import type { DeviceLibrary, DeviceLibraryEntry, DeviceLibraryFiles } from './device-library';

type Factory = NonNullable<DeviceDescription['factory']>;
export const DEMO_ELECTRICAL = Object.freeze({
  sources: { VDD: { voltage: 5 }, VCC: { voltage: 5 } },
  interpretation: 'two-state' as const,
});
export const MODEL_DEVICE_TYPES: readonly string[] = Object.freeze([
  'ideal-led',
  'teaching-mcu',
  'button-ir',
  'relay-ir',
  'potentiometer-ir',
  'resistor-ir',
]);

/** Ordinary state layout; electrical initialization and IR hooks live in paired JS. */
export function describeModel(
  entry: DeviceLibraryEntry,
  factory: Factory,
): DeviceDescription | undefined {
  if (!MODEL_DEVICE_TYPES.includes(entry.type)) return undefined;
  let states: Readonly<Record<string, DeviceStateDescription>> = {};
  switch (entry.type) {
    case 'ideal-led':
      states = {
        lamp: { type: 'bool', initial: false },
        brightness: { type: 'f64', initial: 0 },
      };
      break;
    case 'button-ir':
      states = {
        pressed: { type: 'bool', initial: false },
        settled: { type: 'bool', initial: false },
        debounce: { type: 'u32', initial: 0 },
        closed: { type: 'bool', initial: false },
        pressCount: { type: 'u32', initial: 0 },
      };
      break;
    case 'relay-ir':
      states = { energized: { type: 'bool', initial: false } };
      break;
    case 'potentiometer-ir':
      states = { position: { type: 'f64', initial: 0.5 } };
      break;
  }
  return Object.freeze({
    ...entry.definition,
    name: entry.type,
    pins: entry.pins,
    states,
    factory,
  });
}

export async function loadDeviceFactories(
  files: DeviceLibraryFiles,
  library: DeviceLibrary,
): Promise<ReadonlyMap<string, Factory>> {
  const result = new Map<string, Factory>();
  for (const entry of library.entries) {
    const path = entry.path.replace(/\.json$/, '.js');
    let source: string;
    try {
      source = new TextDecoder().decode(await files.read(path));
    } catch (cause) {
      throw new Error(`${files.label}: cannot read paired implementation ${path}`, { cause });
    }
    // Node supports data modules; worker modules follow the existing widget Blob loader.
    const browser = !('process' in globalThis);
    const url = browser
      ? URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
      : `data:text/javascript,${encodeURIComponent(source)}`;
    try {
      const module = (await import(/* @vite-ignore */ url)) as { default?: unknown };
      if (typeof module.default !== 'function')
        throw new Error('Expected a default synchronous factory');
      result.set(entry.reference, module.default as Factory);
    } catch (cause) {
      throw new Error(`${files.label}: invalid paired implementation ${path}`, { cause });
    } finally {
      if (browser) URL.revokeObjectURL(url);
    }
  }
  return result;
}
