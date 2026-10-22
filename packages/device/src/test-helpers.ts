import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDeviceDescription } from './description';
import type { IDeviceProvider } from './types';

export interface TempDevice {
  readonly dir: string;
  readonly provider: IDeviceProvider;
  cleanup(): Promise<void>;
}

/**
 * Builds a provider over real temporary `.json` / `.js` files so loading tests exercise actual
 * file contents rather than in-memory fixtures. The provider owns the sibling pairing here.
 */
export async function createTempDevice(
  files: Readonly<Record<string, string>>,
  deviceFiles: Readonly<Record<string, string>>,
): Promise<TempDevice> {
  const dir = await mkdtemp(join(tmpdir(), 'mica-device-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8');
  }
  const provider: IDeviceProvider = {
    async resolve(deviceId) {
      const base = deviceFiles[deviceId];
      if (base === undefined) {
        return undefined;
      }
      const json = await readFile(join(dir, `${base}.json`), 'utf8');
      const code = await readFile(join(dir, `${base}.js`), 'utf8');
      const definition: unknown = JSON.parse(json);
      return { definition: parseDeviceDescription(definition, { name: deviceId }), code };
    },
  };
  return {
    dir,
    provider,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
