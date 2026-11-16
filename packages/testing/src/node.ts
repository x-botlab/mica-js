import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseFusedDocument } from '@mica-js/document/fused';
import type { DeviceDependency, FusedInstance } from '@mica-js/document/fused';
import { createDirectoryRegistry } from '@mica-js/sdk/fused/node';
import { createTestbench, type TestbenchOptions } from './testbench';

export { parseUnifiedManifest, validateModelValue } from '@mica-js/document/fused';

export interface FileTestbenchDefinition {
  readonly document: URL;
  readonly devices: Readonly<Record<string, URL>>;
  readonly expected: {
    readonly dependencies: Readonly<Record<string, DeviceDependency>>;
    readonly instances: readonly Pick<FusedInstance, 'id' | 'device' | 'designator'>[];
  };
}

export type FileTestbenchOptions = Omit<TestbenchOptions, 'document' | 'registry' | 'loadModule'>;

export async function createFileTestbench(
  definition: FileTestbenchDefinition,
  options: FileTestbenchOptions,
) {
  const document = parseFusedDocument(await readFile(definition.document, 'utf8'));
  const expected = definition.expected;
  const dependencies = Object.entries(document.dependencies);
  if (
    dependencies.length !== Object.keys(expected.dependencies).length ||
    dependencies.some(
      ([id, lock]) =>
        lock.version !== expected.dependencies[id]?.version ||
        lock.integrity !== expected.dependencies[id]?.integrity,
    )
  ) {
    throw new Error('Generated testbench dependencies are stale; run mitest prepare');
  }
  const inventory = new Map(expected.instances.map((instance) => [instance.id, instance]));
  if (
    document.instances.length !== inventory.size ||
    document.instances.some((instance) => {
      const binding = inventory.get(instance.id);
      return (
        binding === undefined ||
        binding.device !== instance.device ||
        binding.designator !== instance.designator
      );
    })
  ) {
    throw new Error('Generated testbench device bindings are stale; run mitest prepare');
  }
  return createTestbench({
    ...options,
    document,
    registry: createDirectoryRegistry(
      Object.fromEntries(
        Object.entries(definition.devices).map(([id, url]) => [id, fileURLToPath(url)]),
      ),
    ),
    async loadModule(files, path): Promise<unknown> {
      const bytes = await files.read(path);
      return import(
        /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(bytes).toString('base64')}`
      );
    },
  });
}
