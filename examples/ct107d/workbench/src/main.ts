import { DisposableStore } from '@mica-js/core/lifecycle';
import { packagePathProblem, parseFusedDocument } from '@mica-js/document/fused';
import type { DeviceLock, FusedDocument, PackageFiles } from '@mica-js/document/fused';
import {
  createWorkbench,
  type IWorkbench,
  type IWorkbenchDiagnostic,
  type IWorkbenchState,
} from '@mica-js/editor/fused';
import '@mica-js/editor/fused/style.css';
import { packageFileUrl, packageFiles, parseCatalog, type CatalogEntry } from './catalog';
import { DocumentStore } from './document-store';
import { WORKBENCH_STEP } from './runtime-config';
import { HostSessionController } from './session-controller';
import './host.css';

const baseUrl = import.meta.env.BASE_URL.endsWith('/')
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`;
const catalogUrl = `${baseUrl}catalog.json`;
const demoUrl = `${baseUrl}ct107d.sch`;
const port = location.port === '' ? '' : `:${location.port}`;
// The `${id}` label is substituted by the editor for each HTML view's isolated origin.
const viewBaseUrl = `${location.protocol}//\${id}.localhost${port}${baseUrl}environment/`;

const HOST_THEME = {
  appearance: 'dark',
  colors: {
    'workbench.background': '#0d1316',
    'workbench.foreground': '#d7e4e2',
    'workbench.mutedForeground': '#8ca3a1',
    'panel.background': '#121b1f',
    border: '#24343a',
    accent: '#2dd4bf',
    'accent.foreground': '#05201c',
    'selection.background': '#1b2c31',
    'focus.border': '#2dd4bf',
    'canvas.background': '#090e11',
    'canvas.grid': '#182328',
    'canvas.foreground': '#b8cbc8',
    'canvas.wire': '#4fb5a6',
    'canvas.pin': '#7dd3c8',
    'canvas.selection': '#5eead4',
    'error.foreground': '#fb7185',
    shadow: '#00000088',
  },
} as const;

function element<T extends HTMLElement>(id: string, constructor: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof constructor)) throw new Error(`Missing #${id}`);
  return found;
}

const container = element('workbench', HTMLDivElement);
const status = element('status', HTMLSpanElement);
const errorBanner = element('error-banner', HTMLDivElement);
const errorText = element('error', HTMLPreElement);
const saveButton = element('save', HTMLButtonElement);
const reopenButton = element('reopen', HTMLButtonElement);
const restoreButton = element('restore', HTMLButtonElement);
const dismissButton = element('dismiss', HTMLButtonElement);

const decoder = new TextDecoder('utf-8', { fatal: true });
const store = new DocumentStore(window.localStorage);
let catalog: readonly CatalogEntry[] = [];
let subscriptions: DisposableStore | undefined;
let sourceLabel = '演示';

function describe(reason: unknown): string {
  if (reason instanceof Error) {
    const code = 'code' in reason && typeof reason.code === 'string' ? `${reason.code}: ` : '';
    return `${code}${reason.message}`;
  }
  return String(reason);
}

function showError(reason: unknown): void {
  errorText.textContent = describe(reason);
  errorBanner.hidden = false;
}

function clearError(): void {
  errorBanner.hidden = true;
  errorText.textContent = '';
}

function renderState(state: IWorkbenchState): void {
  const mode = state.mode === 'run' ? '运行' : '编辑';
  const saved = state.dirty ? '未保存' : '已保存';
  status.textContent = `${sourceLabel} · ${mode} · ${saved}${state.busy ? ' · 处理中' : ''}`;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
  return new Uint8Array(await response.arrayBuffer());
}

function entryFor(lock: DeviceLock): CatalogEntry {
  const entry = catalog.find(
    (candidate) =>
      candidate.lock.id === lock.id &&
      candidate.lock.version === lock.version &&
      candidate.lock.integrity === lock.integrity,
  );
  if (entry === undefined) {
    throw new Error(`Unknown locked release ${lock.id}@${lock.version}`);
  }
  return entry;
}

const deviceProvider = {
  async open(lock: DeviceLock): Promise<PackageFiles> {
    const entry = entryFor(lock);
    return packageFiles(entry, async (path: string) => {
      if (packagePathProblem(path) !== undefined || !Object.hasOwn(entry.files, path)) {
        throw new Error(`Undeclared package file ${path}`);
      }
      return fetchBytes(packageFileUrl(baseUrl, entry, path));
    });
  },
};

const controller = new HostSessionController<IWorkbench>({
  create: async (document: FusedDocument, saveDocument: (snapshot: FusedDocument) => Promise<void>) =>
    createWorkbench({
      container,
      document,
      saveDocument,
      deviceProvider,
      viewBaseUrlTemplate: viewBaseUrl,
      theme: HOST_THEME,
      step: WORKBENCH_STEP,
    }),
  saveDocument: (snapshot) => store.save(snapshot),
  savedLabel: '本地保存',
  onDidOpen(session, label) {
    sourceLabel = label;
    const active = new DisposableStore();
    subscriptions = active;
    active.add(session.onDidChangeState(renderState));
    active.add(
      session.onDidReportDiagnostic((diagnostic: IWorkbenchDiagnostic) => {
        if (diagnostic.severity === 'error') {
          showError(`${diagnostic.code}: ${diagnostic.message}`);
        }
      }),
    );
    renderState(session.getState());
  },
  onDidSave(session, label) {
    sourceLabel = label;
    renderState(session.getState());
  },
  onWillClose() {
    subscriptions?.dispose();
    subscriptions = undefined;
  },
});

function openDocument(document: FusedDocument, label: string): Promise<void> {
  status.textContent = `正在装载${label}…`;
  clearError();
  return controller.open(document, label).catch((reason: unknown) => {
    status.textContent = '装载失败';
    throw reason;
  });
}

function openBytes(bytes: Uint8Array, label: string): Promise<void> {
  let document: FusedDocument;
  try {
    document = parseFusedDocument(decoder.decode(bytes));
  } catch (reason) {
    showError(reason);
    return Promise.resolve();
  }
  return openDocument(document, label);
}

async function openDemo(): Promise<void> {
  await openBytes(await fetchBytes(demoUrl), '演示');
}

/** Save is queued behind an in-flight replacement through the session controller. */
async function save(): Promise<void> {
  await controller.save();
}

/** Reopen validates the draft before replacing the live session. */
function reopen(): Promise<void> {
  status.textContent = '正在读取本地草稿…';
  clearError();
  return controller.reopen(() => store.load()).catch((reason: unknown) => {
    status.textContent = '装载失败';
    throw reason;
  });
}

function handled(task: () => Promise<void>): void {
  void task().catch(showError);
}

saveButton.addEventListener('click', () => handled(save));
reopenButton.addEventListener('click', () => handled(reopen));
restoreButton.addEventListener('click', () => handled(openDemo));
dismissButton.addEventListener('click', clearError);

window.addEventListener('pagehide', () => {
  // `suspend` captures the current (or pending) document before releasing it, so a bfcache
  // `pageshow` can restore the same document instead of leaving the page inert.
  void controller.suspend().catch(() => undefined);
});

window.addEventListener('pageshow', () => {
  if (!controller.isSuspended) return;
  handled(() => controller.resume());
});

window.addEventListener('unhandledrejection', (event) => {
  showError(event.reason);
});

window.addEventListener('error', (event) => {
  if (event.error !== undefined && event.error !== null) showError(event.error);
});

async function start(): Promise<void> {
  try {
    const raw: unknown = JSON.parse(decoder.decode(await fetchBytes(catalogUrl)));
    catalog = parseCatalog(raw);
    await openDemo();
  } catch (reason) {
    showError(reason);
    status.textContent = '准备失败';
  }
}

void start();
