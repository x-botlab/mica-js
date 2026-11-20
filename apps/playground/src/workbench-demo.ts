import { toTimePs } from '@mica-js/core';
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
import type { ProgramArtifact, ProgramProject, ProgramTarget } from '@mica-js/sdk/fused';
import { ct117eFirmware } from '../workbench-assets.json';
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
      !/^[a-z][a-z0-9-]*$/.test(item.directory)
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
async function fetchBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal: signal ?? null });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

const container = element('#workbench', HTMLDivElement);
const status = element('#status', HTMLSpanElement);
const error = element('#error', HTMLPreElement);
const entitled = element('#entitled', HTMLInputElement);
const storageKey = 'mica-fused-workbench-example-v1';
const base = `${import.meta.env.BASE_URL}components/workbench/`;
const ct117eDemo = `${base}ct117e-m4.sch`;
const changes = new Emitter<void>();
const demoHex = new TextEncoder().encode(':0E0000007590FF75B0FFA2B29290929180F8B9\n:00000001FF\n');
const assets = new Map<string, { name: string; kind: string; data: Uint8Array | string }>([
  [
    'f985ad84-10b2-4478-8415-986e432081ef',
    { name: '按键控制.hex', kind: 'program', data: demoHex },
  ],
  [
    'f1a470c5-20a6-4083-ab90-822af27f91fc',
    {
      name: '面板.svg',
      kind: 'image',
      data: new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#4388cc"/></svg>',
      ),
    },
  ],
  [
    ct117eFirmware.assetId,
    {
      name: ct117eFirmware.name,
      kind: 'program',
      data: `${base}firmware/${ct117eFirmware.name}`,
    },
  ],
]);
const programProjects = new Map<
  string,
  { project: ProgramProject; loader: ProgramTarget['loader']; artifact: ProgramArtifact }
>([
  [
    'demo-memory',
    {
      project: { id: 'demo-memory', title: '内存项目示例' },
      loader: 'memory',
      artifact: { kind: 'memory', format: 'hex', data: demoHex },
    },
  ],
  [
    'demo-scripts',
    {
      project: { id: 'demo-scripts', title: '脚本项目示例' },
      loader: 'filesystem',
      artifact: {
        kind: 'filesystem',
        files: [{ path: 'main.py', data: new TextEncoder().encode('print("Hello")\n') }],
      },
    },
  ],
]);
const audioContext = typeof AudioContext === 'undefined' ? undefined : new AudioContext();
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

function selectHostItem<T extends { readonly title: string }>(
  title: string,
  items: readonly T[],
  signal: AbortSignal,
): Promise<T | undefined> {
  signal.throwIfAborted();
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'workbench-host-picker';
    dialog.setAttribute('aria-label', title);
    const heading = document.createElement('h2');
    heading.textContent = title;
    dialog.append(heading);
    let settled = false;
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    const cancel = () => finish(undefined);
    for (const item of items) {
      const button = document.createElement('button');
      button.textContent = item.title;
      button.addEventListener('click', () => finish(item));
      dialog.append(button);
    }
    if (!items.length) {
      const empty = document.createElement('p');
      empty.textContent = '没有匹配的内容';
      dialog.append(empty);
    }
    const close = document.createElement('button');
    close.textContent = '取消';
    close.addEventListener('click', cancel);
    dialog.append(close);
    dialog.addEventListener('cancel', cancel);
    dialog.addEventListener('close', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
}

async function open(bytes: Uint8Array): Promise<void> {
  await workbench?.dispose();
  workbench = undefined;
  error.hidden = true;
  const circuit = parseFusedDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const hasCt117e = circuit.instances.some((instance) => instance.device === 'example:ct117e-m4');
  const result = await createWorkbench({
    ...(audioContext === undefined ? {} : { audio: { context: audioContext } }),
    // As in CT107D, advance a visible amount of sim time on each host yield.
    ...(hasCt117e ? { step: toTimePs(16, 'ms') } : {}),
    container,
    document: circuit,
    saveDocument: async (value) => {
      localStorage.setItem(storageKey, JSON.stringify(value));
    },
    assetProvider: {
      async select(request) {
        const available = [...assets]
          .filter(
            ([, asset]) =>
              asset.kind === request.kind &&
              (!request.formats?.length ||
                request.formats.some((format) => asset.name.endsWith(`.${format}`))),
          )
          .map(([id, asset]) => ({ id, title: asset.name }));
        const asset = await selectHostItem('资产库', available, request.signal);
        return asset === undefined ? undefined : { id: asset.id, name: asset.title };
      },
      async read(id, signal) {
        signal.throwIfAborted();
        const asset = assets.get(id);
        if (!asset) throw new Error(`Unavailable asset ${id}`);
        return typeof asset.data === 'string' ? fetchBytes(asset.data, signal) : asset.data.slice();
      },
    },
    viewBaseUrlTemplate: `${location.protocol}//\${id}.localhost${location.port ? `:${location.port}` : ''}${base}environment/`,
    accessProvider: policy,
    programs: {
      projects: {
        async select(target, signal) {
          const projects = [...programProjects.values()]
            .filter((value) => value.loader === target.loader)
            .map((value) => ({ ...value.project, template: false }));
          const templates = target.templateIds.flatMap((id) => {
            const value = programProjects.get(id);
            return value?.loader === target.loader
              ? [{ id, title: `从模板新建：${value.project.title}`, template: true }]
              : [];
          });
          const selected = await selectHostItem('项目', [...projects, ...templates], signal);
          if (selected === undefined) return undefined;
          signal.throwIfAborted();
          const value = programProjects.get(selected.id);
          if (!value || value.loader !== target.loader)
            throw new Error(`Unavailable project ${selected.id}`);
          if (!selected.template) return value.project;
          const project = { id: crypto.randomUUID(), title: `${value.project.title}（副本）` };
          programProjects.set(project.id, {
            project,
            loader: value.loader,
            artifact: value.artifact,
          });
          return project;
        },
        async resolve(id, target) {
          const value = programProjects.get(id);
          if (!value || value.loader !== target.loader)
            throw new Error(`Unavailable program project ${id}`);
          return value.artifact;
        },
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
                button.textContent =
                  {
                    'workbench:led': 'LED（付费）',
                    'workbench:button': '轻触开关',
                    'workbench:at89c52': 'AT89C52',
                    'workbench:buzzer': '有源蜂鸣器',
                    'example:ct117e-m4': 'CT117E-M4',
                  }[item.lock.id] ?? item.lock.id;
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
  result.onDidRequestOpenProject(({ projectId }) => {
    status.textContent = `打开项目：${programProjects.get(projectId)?.project.title ?? projectId}`;
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
element('#mcu', HTMLButtonElement).addEventListener('click', () =>
  run(fetchBytes(`${base}mcu.sch`).then(open)),
);
element('#ct117e-m4', HTMLButtonElement).addEventListener('click', () =>
  run(fetchBytes(ct117eDemo).then(open)),
);
element('#free', HTMLButtonElement).addEventListener('click', () =>
  run(
    (async () => {
      const document = parseFusedDocument(
        new TextDecoder().decode(await fetchBytes(`${base}circuit.sch`)),
      );
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
    if (new URLSearchParams(location.search).get('demo') === 'ct117e-m4') {
      await open(await fetchBytes(ct117eDemo));
    } else {
      const saved = localStorage.getItem(storageKey);
      await open(
        saved === null ? await fetchBytes(`${base}circuit.sch`) : new TextEncoder().encode(saved),
      );
    }
  })(),
);
