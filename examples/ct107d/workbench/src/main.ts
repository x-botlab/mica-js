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
import {
  looksLikeHtml,
  packageFileUrl,
  packageFiles,
  parseCatalog,
  type CatalogEntry,
} from './catalog';
import { DocumentStore } from './document-store';
import { WORKBENCH_STEP } from './runtime-config';
import { HostSessionController, HostSessionError } from './session-controller';
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
let draftAvailable = false;
let lastState: IWorkbenchState | undefined;

function describe(reason: unknown): string {
  if (reason instanceof Error) {
    if ('code' in reason && typeof reason.code === 'string') {
      const prefix = `${reason.code}: `;
      return reason.message.startsWith(prefix) ? reason.message : `${prefix}${reason.message}`;
    }
    return reason.message;
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

function renderStatus(): void {
  if (lastState === undefined) return;
  const mode = lastState.mode === 'run' ? '运行' : '编辑';
  const changed = lastState.dirty ? '有修改' : '未修改';
  const draft = draftAvailable ? '已本地保存' : '无本地保存（请先保存）';
  status.textContent = `${sourceLabel} · ${mode} · ${changed} · ${draft}${lastState.busy ? ' · 处理中' : ''}`;
}

function refreshControls(): void {
  const hasSession = controller.current !== undefined;
  saveButton.disabled = !hasSession;
  reopenButton.disabled = !hasSession || !draftAvailable;
  saveButton.title = hasSession ? '保存当前文档到浏览器草稿' : '工作台尚未装载完成';
  reopenButton.title = !hasSession
    ? '工作台尚未装载完成'
    : draftAvailable
      ? '打开浏览器保存的草稿'
      : '请先保存当前文档';
}

/** Refreshes draft availability; a storage read failure disables the action, never fakes it. */
function refreshDraftAvailability(): boolean {
  try {
    draftAvailable = store.hasDraft();
  } catch (reason) {
    draftAvailable = false;
    showError(new Error(`无法读取浏览器本地存储：${describe(reason)}`));
  }
  refreshControls();
  renderStatus();
  return draftAvailable;
}

function onState(state: IWorkbenchState): void {
  lastState = state;
  renderStatus();
}

async function fetchBytes(
  url: string,
  label: string,
  rejectHtmlFallback = false,
): Promise<Uint8Array> {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${label}（${url}）: HTTP ${String(response.status)}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') ?? '';
  if (rejectHtmlFallback && (contentType.includes('text/html') || looksLikeHtml(bytes))) {
    throw new Error(
      `${label}（${url}）返回了 HTML 而不是预期资源；` +
        '请运行 workbench prepare 并检查 public 资源路径。',
    );
  }
  return bytes;
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
      const textual = path.endsWith('.js') || path.endsWith('.json');
      return fetchBytes(packageFileUrl(baseUrl, entry, path), `器件包文件 ${path}`, textual);
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
  savedLabel: '本地',
  draftLabel: '本地',
  onDidOpen(session, label) {
    sourceLabel = label;
    lastState = session.getState();
    const active = new DisposableStore();
    subscriptions = active;
    active.add(session.onDidChangeState(onState));
    active.add(
      session.onDidReportDiagnostic((diagnostic: IWorkbenchDiagnostic) => {
        if (diagnostic.severity === 'error') {
          showError(`${diagnostic.code}: ${diagnostic.message}`);
        }
      }),
    );
    refreshDraftAvailability();
  },
  onDidSave(session, label) {
    sourceLabel = label;
    lastState = session.getState();
    clearError();
    refreshDraftAvailability();
  },
  onWillClose() {
    subscriptions?.dispose();
    subscriptions = undefined;
    lastState = undefined;
    refreshControls();
  },
});

function openDocument(document: FusedDocument, label: string): Promise<void> {
  lastState = undefined;
  status.textContent = `正在装载${label}…`;
  refreshControls();
  clearError();
  return controller.open(document, label).catch((reason: unknown) => {
    status.textContent = '装载失败';
    refreshControls();
    throw reason;
  });
}

function openBytes(bytes: Uint8Array, label: string, source?: string): Promise<void> {
  let document: FusedDocument;
  try {
    document = parseFusedDocument(decoder.decode(bytes));
  } catch (reason) {
    showError(
      source === undefined
        ? new Error(`本地草稿无法解析：${describe(reason)}`, { cause: reason })
        : new Error(`${source}: 不是有效的 v2 文档：${describe(reason)}`, { cause: reason }),
    );
    status.textContent = '装载失败';
    return Promise.resolve();
  }
  return openDocument(document, label);
}

async function openDemo(): Promise<void> {
  await openBytes(await fetchBytes(demoUrl, 'ct107d.sch', true), '演示', demoUrl);
}

/** Save is queued behind an in-flight replacement through the session controller. */
async function save(): Promise<void> {
  if (controller.current === undefined) {
    status.textContent = '工作台尚未装载完成，未保存';
    refreshControls();
    return;
  }
  try {
    await controller.save();
  } catch (reason) {
    refreshDraftAvailability();
    if (reason instanceof HostSessionError && reason.code === 'host/no-session') {
      status.textContent = '工作台尚未装载完成，未保存';
      refreshControls();
      return;
    }
    throw reason;
  }
  if (!refreshDraftAvailability()) {
    throw new Error('本地保存未写入浏览器存储，重新打开仍不可用。');
  }
}

/** Reopen validates the draft before replacing the live session. */
function reopen(): Promise<void> {
  if (controller.current === undefined) {
    status.textContent = '工作台尚未装载完成';
    refreshControls();
    return Promise.resolve();
  }
  if (!refreshDraftAvailability()) {
    renderStatus();
    return Promise.resolve();
  }
  status.textContent = '正在读取本地草稿…';
  clearError();
  return controller.reopen(() => store.load()).catch((reason: unknown) => {
    if (reason instanceof HostSessionError && reason.code === 'host/no-draft') {
      refreshDraftAvailability();
      if (lastState === undefined) status.textContent = '无本地保存（请先保存）';
      else renderStatus();
      return;
    }
    status.textContent = '装载失败';
    refreshControls();
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

window.addEventListener('storage', (event) => {
  if (event.key !== null && event.key !== store.key) return;
  refreshDraftAvailability();
});

window.addEventListener('pagehide', () => {
  // `suspend` captures the current (or pending) document before releasing it, so a bfcache
  // `pageshow` can restore the same document instead of leaving the page inert.
  saveButton.disabled = true;
  reopenButton.disabled = true;
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

refreshDraftAvailability();

async function start(): Promise<void> {
  try {
    const text = decoder.decode(await fetchBytes(catalogUrl, 'catalog.json', true));
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (cause) {
      throw new Error(`${catalogUrl}: 不是有效的 catalog JSON：${describe(cause)}`, {
        cause,
      });
    }
    catalog = parseCatalog(raw);
    await openDemo();
  } catch (reason) {
    showError(reason);
    status.textContent = '准备失败';
    refreshControls();
  }
}

void start();
