import {
  DEVICE_LIBRARY_ROOT,
  PLAYGROUND_DEVICE_EXTENSIONS,
  loadDeviceLibrary,
  type DeviceLibrary,
  type DeviceLibraryFiles,
} from './device-library';

export { DEVICE_LIBRARY_ROOT };

/** Reads the Playground device contracts over the page's own origin. */
export const PLAYGROUND_DEVICE_FILES: DeviceLibraryFiles = {
  label: 'demo',
  read: async (path) => {
    const response = await fetch(new URL(`${DEVICE_LIBRARY_ROOT}/${path}`, document.baseURI));
    if (!response.ok) {
      throw new Error(`读取 ${DEVICE_LIBRARY_ROOT}/${path} 失败（HTTP ${response.status}）`);
    }
    return new Uint8Array(await response.arrayBuffer());
  },
};

let library: Promise<DeviceLibrary> | undefined;

/** Loads `public/devices` once per page; every consumer shares the same immutable contract set. */
export function loadPlaygroundDeviceLibrary(): Promise<DeviceLibrary> {
  library ??= loadDeviceLibrary(PLAYGROUND_DEVICE_FILES, PLAYGROUND_DEVICE_EXTENSIONS);
  return library;
}
