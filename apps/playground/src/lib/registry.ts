import type { IDeviceProvider } from '@mica-js/device';
import {
  createDeviceRegistry,
  isTextDevice,
  readPropertyDescriptors,
  type DevicePackageRegistration,
  type DeviceRegistrationEntry,
  type DeviceSymbolDefinition,
  type DeviceSymbolProvider,
  type PropertyDescriptor,
} from '@mica-js/core/schematic';
import {
  createPackageWidgetProvider,
  loadWidgetPackage,
  type PackageFiles,
  type WidgetPackage,
  type WidgetProvider,
} from '@mica-js/widget';
import { BOARD_DEVICE_PACKAGES } from '@/devices/board';
import { PLAYGROUND_DEVICES, createPlaygroundDefinition } from '@/devices';
import { SAMPLE_DEVICE_PACKAGES } from '@/schematic/sample';
import { PLAYGROUND_WIDGET_FILES } from '@/widgets';
import buttonDescription from '../../../../packages/device/examples/ideal-button/ideal-button.json?raw';
import mcuDescription from '../../../../packages/device/examples/teaching-mcu/teaching-mcu.json?raw';
import relayDescription from '../../../../packages/device/examples/ideal-relay/ideal-relay.json?raw';

/**
 * One place every example asks for its parts.
 *
 * Pages never assemble a package list themselves: a device added here is available
 * to every schematic example, and a widget added to either widget package shows up
 * in every canvas example's palette.
 */

/** `mica:` examples are read from the committed device packages, so pages never drift. */
const EXAMPLE_DEVICE_ENTRIES: readonly DeviceRegistrationEntry[] = [
  {
    id: 'ideal-button',
    displayName: '理想按钮',
    raw: JSON.parse(buttonDescription) as Readonly<Record<string, unknown>>,
  },
  {
    id: 'ideal-relay',
    displayName: '理想继电器',
    raw: JSON.parse(relayDescription) as Readonly<Record<string, unknown>>,
  },
  {
    id: 'teaching-mcu',
    displayName: '教学 MCU',
    raw: JSON.parse(mcuDescription) as Readonly<Record<string, unknown>>,
  },
];

const LAB_ENTRIES: readonly DeviceRegistrationEntry[] = PLAYGROUND_DEVICES.map((device) => ({
  id: device.deviceId,
  displayName: device.displayName,
  description: device.description,
  raw: device.package,
}));

const DEVICE_PACKAGES: readonly DevicePackageRegistration[] = [
  ...SAMPLE_DEVICE_PACKAGES,
  ...BOARD_DEVICE_PACKAGES,
  { packageId: 'mica', devices: EXAMPLE_DEVICE_ENTRIES },
  { packageId: 'lab', devices: LAB_ENTRIES },
];

const registry = createDeviceRegistry(DEVICE_PACKAGES);

/**
 * `builtin:text` is a loader-provided annotation, so it never reaches a package
 * registry (the `builtin` namespace is reserved). The editor renders it without
 * geometry, but topology derivation still asks the provider for a name.
 */
const TEXT_SYMBOL: DeviceSymbolDefinition = { name: '文本', pins: {} };
const TEXT_PROPERTIES: ReadonlyMap<string, PropertyDescriptor> = readPropertyDescriptors({
  text: { type: 'string', title: '文本', default: '' },
});

const deviceSymbols: DeviceSymbolProvider = {
  getDeviceSymbol(reference) {
    return isTextDevice(reference.raw) ? TEXT_SYMBOL : registry.getDeviceSymbol(reference);
  },
  getDeviceName(reference) {
    return isTextDevice(reference.raw) ? TEXT_SYMBOL.name : registry.getDeviceName(reference);
  },
  getDeviceDesignatorPrefix(reference) {
    return isTextDevice(reference.raw)
      ? undefined
      : registry.getDeviceDesignatorPrefix?.(reference);
  },
  getDevicePropertyDescriptors(reference) {
    return isTextDevice(reference.raw)
      ? TEXT_PROPERTIES
      : registry.getDevicePropertyDescriptors?.(reference);
  },
};

/** Symbol provider every schematic example hands to `mountSchematicEditor`. */
export function getDeviceRegistry(): DeviceSymbolProvider {
  return deviceSymbols;
}

/** Device source for the canvas examples: every `lab:` part the playground ships. */
export const simulationDevices: IDeviceProvider = {
  resolve(deviceId) {
    return createPlaygroundDefinition(deviceId);
  },
};

export function getSimulationDevices(): IDeviceProvider {
  return simulationDevices;
}

/** The public demo package stays on disk; examples fetch it like any host would. */
const DEMO_WIDGET_FILES: PackageFiles = {
  label: 'demo',
  async read(path: string): Promise<Uint8Array> {
    const response = await fetch(new URL(`widgets/${path}`, globalThis.document.baseURI));
    if (!response.ok) {
      throw new Error(`读取 widgets/${path} 失败（HTTP ${response.status}）`);
    }
    return new Uint8Array(await response.arrayBuffer());
  },
};

export interface WidgetRegistry {
  /** Resolves `demo:` and `lab:` widget modules for the canvas editor and host. */
  readonly provider: WidgetProvider;
  /** Loaded packages, in palette order: the on-disk demo first, then the bundled lab set. */
  readonly packages: readonly WidgetPackage[];
}

const WIDGET_FILES: readonly PackageFiles[] = [DEMO_WIDGET_FILES, PLAYGROUND_WIDGET_FILES];

let widgetRegistry: Promise<WidgetRegistry> | undefined;

async function createWidgetRegistry(): Promise<WidgetRegistry> {
  const [provider, packages] = await Promise.all([
    createPackageWidgetProvider({ files: WIDGET_FILES }),
    Promise.all(WIDGET_FILES.map((files) => loadWidgetPackage(files))),
  ]);
  return { provider, packages };
}

/** Loads every widget package once; a failed load is retried on the next call. */
export function getWidgetRegistry(): Promise<WidgetRegistry> {
  if (widgetRegistry === undefined) {
    widgetRegistry = createWidgetRegistry().catch((error: unknown) => {
      widgetRegistry = undefined;
      throw error;
    });
  }
  return widgetRegistry;
}
