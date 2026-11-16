import { Emitter } from '@mica-js/core/lifecycle';
import {
  parseFusedDocument,
  type DeviceLock,
  type PackageFile,
  type PackageFiles,
} from '@mica-js/document/fused';
import {
  createWorkbench,
  type IWorkbench,
  type IWorkbenchAccessProvider,
} from '@mica-js/editor/fused';
import '@mica-js/editor/fused/style.css';
import './workbench-demo.css';

interface ICatalogEntry {
  readonly lock: DeviceLock;
  readonly files: Readonly<Record<string, PackageFile>>;
  readonly directory: string;
}

function element<T extends HTMLElement>(selector: string, constructor: new () => T): T {
  const result = document.querySelector(selector);
  if (!(result instanceof constructor)) throw new Error(`Missing ${selector}`);
  return result;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseCatalog(value: unknown): readonly ICatalogEntry[] {
  if (!Array.isArray(value)) throw new Error('Invalid catalog');
  return value.map((item: unknown) => {
    if (
      !record(item) ||
      !record(item.lock) ||
      !record(item.files) ||
      typeof item.directory !== 'string' ||
      !/^[a-z]+$/.test(item.directory)
    )
      throw new Error('Invalid catalog entry');
    const { id, version, integrity } = item.lock;
    if (typeof id !== 'string' || typeof version !== 'string' || typeof integrity !== 'string')
      throw new Error('Invalid device lock');
    const files: Record<string, PackageFile> = {};
    for (const [path, file] of Object.entries(item.files)) {
      if (!record(file) || typeof file.size !== 'number' || typeof file.integrity !== 'string')
        throw new Error(`Invalid package file ${path}`);
      files[path] = { size: file.size, integrity: file.integrity };
    }
    return { lock: { id, version, integrity }, directory: item.directory, files };
  });
}
async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

const container = element('#workbench', HTMLDivElement);
const status = element('#status', HTMLSpanElement);
const error = element('#error', HTMLPreElement);
const entitled = element('#entitled', HTMLInputElement);
const storageKey = 'mica-fused-workbench-example-v1';
const uri = 'memory://workbench/circuit.sch';
const base = '/components/workbench/';
const changes = new Emitter<void>();
const files = new Map<string, Uint8Array>();
let workbench: IWorkbench | undefined;
let catalog: readonly ICatalogEntry[] = [];
const policy: IWorkbenchAccessProvider = {
  onDidChange: changes.event,
  async evaluateDocument({ document }) {
    return {
      edit:
        !entitled.checked &&
        document.instances.some((instance) => instance.device === 'workbench:led')
          ? {
              allowed: false,
              code: 'demo/paid-device',
              message: '该文档包含付费器件，请先启用付费器件再编辑。',
            }
          : { allowed: true },
      run: { allowed: true },
    };
  },
  async canAddDevice({ device }) {
    return device.id === 'workbench:led' && !entitled.checked
      ? { allowed: false, code: 'demo/paid-device', message: 'LED 需要付费授权。' }
      : { allowed: true };
  },
};
const showError = (reason: unknown) => {
  error.hidden = false;
  error.textContent = reason instanceof Error ? reason.message : String(reason);
};
const run = (task: Promise<unknown>) => void task.catch(showError);
const theme = element('#theme', HTMLSelectElement);
const accent = element('#accent', HTMLInputElement);
function updateTheme(): void {
  const appearance = theme.value;
  if (appearance !== 'dark' && appearance !== 'light' && appearance !== 'system')
    throw new Error('Unknown theme appearance');
  const linear = (offset: number) => {
    const channel = Number.parseInt(accent.value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const luminance = linear(1) * 0.2126 + linear(3) * 0.7152 + linear(5) * 0.0722;
  workbench?.setTheme({
    appearance,
    colors: {
      accent: accent.value,
      'accent.foreground': luminance > 0.179 ? '#000000' : '#ffffff',
    },
  });
}
theme.addEventListener('change', updateTheme);
accent.addEventListener('input', updateTheme);

async function open(bytes: Uint8Array): Promise<void> {
  await workbench?.dispose();
  workbench = undefined;
  files.set(uri, bytes.slice());
  error.hidden = true;
  const result = await createWorkbench({
    container,
    uri,
    viewBaseUrlTemplate: `http://\${id}.localhost:${location.port}/components/workbench/environment/`,
    accessProvider: policy,
    fileSystemProvider: {
      async read(path) {
        const value = files.get(path);
        if (value === undefined) throw new Error(`Unknown host file ${path}`);
        return value.slice();
      },
      async write(path, value) {
        files.set(path, value.slice());
        if (path === uri) localStorage.setItem(storageKey, new TextDecoder().decode(value));
      },
    },
    deviceProvider: {
      async open(lock): Promise<PackageFiles> {
        const item = catalog.find(
          (entry) =>
            entry.lock.id === lock.id &&
            entry.lock.version === lock.version &&
            entry.lock.integrity === lock.integrity,
        );
        if (item === undefined) throw new Error(`Unknown release ${lock.id}`);
        return {
          lock: item.lock,
          files: item.files,
          async read(path) {
            if (!Object.hasOwn(item.files, path))
              throw new Error(`Undeclared package file ${path}`);
            return fetchBytes(
              `${base}${item.directory}/${path.split('/').map(encodeURIComponent).join('/')}`,
            );
          },
        };
      },
    },
    contributions: {
      containers: [{ id: 'demo.library', title: '器件库', icon: 'circuit-board', order: 0 }],
      views: [
        {
          id: 'demo.devices',
          containerId: 'demo.library',
          title: '器件',
          mount(target, context) {
            const search = document.createElement('input');
            search.type = 'search';
            search.placeholder = '搜索器件';
            search.setAttribute('aria-label', '搜索器件');
            const list = document.createElement('div');
            const render = () => {
              list.replaceChildren();
              for (const item of catalog.filter((entry) =>
                entry.lock.id.includes(search.value.toLowerCase()),
              )) {
                const button = document.createElement('button');
                button.textContent = item.lock.id === 'workbench:led' ? 'LED（付费）' : '轻触开关';
                button.className = 'demo-device';
                button.addEventListener('click', () =>
                  run(context.workbench.executeCommand('device.place', { device: item.lock })),
                );
                list.append(button);
              }
            };
            search.addEventListener('input', render);
            target.append(search, list);
            render();
            return { dispose: () => target.replaceChildren() };
          },
        },
      ],
      toolbar: [
        {
          id: 'demo.addDevice',
          title: '器件',
          icon: 'add',
          group: 'insert',
          when: "workbench.mode == 'edit'",
          enablement: 'document.editable && !workbench.busy',
          execute: (context) =>
            context.workbench.executeCommand('workbench.openContainer', {
              id: 'demo.library',
              focus: true,
            }),
        },
      ],
    },
  });
  workbench = result;
  updateTheme();
  const update = () => {
    const state = result.getState();
    const mode = state.mode === 'run' ? '运行' : '编辑';
    const saved = state.readOnly ? '只读' : state.dirty ? '未保存' : '已保存';
    status.textContent = `${mode} · ${saved}`;
  };
  result.onDidChangeState(update);
  result.onDidReportDiagnostic((diagnostic) => {
    if (diagnostic.severity === 'error') showError(`${diagnostic.code}: ${diagnostic.message}`);
  });
  update();
  Object.assign(globalThis, {
    fusedDemo: { workbench: result, devices: catalog.map((entry) => entry.lock) },
  });
}

element('#width', HTMLInputElement).addEventListener('input', (event) => {
  if (event.target instanceof HTMLInputElement) container.style.width = `${event.target.value}px`;
});
entitled.addEventListener('change', () => changes.fire());
element('#save', HTMLButtonElement).addEventListener('click', () => {
  if (workbench !== undefined) run(workbench.save());
});
element('#reopen', HTMLButtonElement).addEventListener('click', () => {
  const saved = localStorage.getItem(storageKey);
  if (saved === null) showError('请先保存文档再重新打开。');
  else run(open(new TextEncoder().encode(saved)));
});
element('#reset', HTMLButtonElement).addEventListener('click', () => {
  localStorage.removeItem(storageKey);
  run(fetchBytes(`${base}circuit.sch`).then(open));
});
element('#free', HTMLButtonElement).addEventListener('click', () =>
  run(
    (async () => {
      const document = parseFusedDocument(await fetchBytes(`${base}circuit.sch`));
      const instance = document.instances.find((value) => value.device === 'workbench:button');
      if (instance === undefined) throw new Error('Missing example button');
      await open(
        new TextEncoder().encode(
          JSON.stringify({ ...document, instances: [instance], wires: [], references: [] }),
        ),
      );
    })(),
  ),
);
run(
  (async () => {
    catalog = parseCatalog(
      JSON.parse(new TextDecoder().decode(await fetchBytes(`${base}catalog.json`))),
    );
    const saved = localStorage.getItem(storageKey);
    await open(
      saved === null ? await fetchBytes(`${base}circuit.sch`) : new TextEncoder().encode(saved),
    );
  })(),
);
