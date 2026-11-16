import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDevice } from '@mica-js/sdk/device-build';
import { readDirectoryPackage } from '@mica-js/sdk/fused/node';
import { build, createServer } from 'vite';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(app, '..', '..', 'examples', 'fused-workbench');
const artifacts = resolve(app, 'public', 'components', 'workbench');
const devices = [];
for (const name of ['button', 'led']) {
  const root = resolve(source, name);
  const outDir = resolve(root, 'dist');
  await buildDevice({ root, manifest: 'package.json', model: 'src/model.ddl', outDir });
  const files = await readDirectoryPackage(outDir);
  devices.push({ lock: files.lock, files: files.files, directory: name });
  await mkdir(resolve(artifacts, name), { recursive: true });
  await cp(outDir, resolve(artifacts, name), { recursive: true });
}
const button = '11111111-1111-4111-8111-111111111111';
const led = '22222222-2222-4222-8222-222222222222';
const document = {
  version: 2,
  dependencies: Object.fromEntries(
    devices.map(({ lock }) => [lock.id, { version: lock.version, integrity: lock.integrity }]),
  ),
  instances: [
    {
      id: button,
      device: 'workbench:button',
      designator: 'S1',
      placement: { x: 0, y: 0, rotation: 0 },
    },
    { id: led, device: 'workbench:led', designator: 'D1', placement: { x: 28, y: 1, rotation: 0 } },
  ],
  nodes: [],
  wires: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      from: { kind: 'pin', instance: button, pin: 'b1' },
      to: { kind: 'pin', instance: led, pin: 'anode' },
      bends: [
        { x: 20, y: 2 },
        { x: 20, y: 5 },
      ],
    },
  ],
  labels: [],
  references: [
    {
      id: '44444444-4444-4444-8444-444444444444',
      target: { kind: 'pin', instance: button, pin: 'a1' },
      voltage: 5,
      symbol: 'power',
    },
    {
      id: '55555555-5555-4555-8555-555555555555',
      target: { kind: 'pin', instance: led, pin: 'cathode' },
      voltage: 0,
      symbol: 'ground',
    },
  ],
};
await writeFile(resolve(artifacts, 'catalog.json'), JSON.stringify(devices));
await writeFile(resolve(artifacts, 'circuit.sch'), JSON.stringify(document, null, 2));
await cp(
  resolve(app, '..', '..', 'packages', 'editor', 'dist', 'view-environment'),
  resolve(artifacts, 'environment'),
  { recursive: true },
);
if (process.argv[2] === 'build') {
  await build({ root: app, build: { rollupOptions: { input: resolve(app, 'workbench.html') } } });
} else if (process.argv[2] === 'prepare') {
  console.log('Fused workbench packages prepared.');
} else {
  const port = Number(process.env.PORT ?? 5193);
  const server = await createServer({
    root: app,
    server: { port, strictPort: true, host: '127.0.0.1' },
  });
  await server.listen();
  server.printUrls();
  server.bindCLIShortcuts({ print: true });
}
