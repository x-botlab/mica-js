import { SandboxError, createSandbox } from '@mica-js/sandbox';
import type {
  SandboxCapabilities,
  SandboxHandle,
  SandboxLogEntry,
  SandboxSource,
} from '@mica-js/sandbox';
import {
  basicsGuest,
  brokenGuest,
  capabilityGuest,
  classicGuest,
  errorsGuest,
  eventsGuest,
  isolationGuest,
  offscreen2dGuest,
  offscreenWebglGuest,
  spinGuest,
} from './guests';
import './style.css';

type FrameMode = 'inline' | 'url';

interface BootOptions {
  canvas?: HTMLCanvasElement;
  capabilities?: SandboxCapabilities;
  callTimeoutMs?: number;
  onCallTimeout?: 'reject' | 'terminate';
}

interface ScenarioApi {
  panel: HTMLElement;
  mode(): FrameMode;
  log(level: string, ...parts: unknown[]): void;
  setStatus(text: string): void;
  boot(source: SandboxSource, options?: BootOptions): Promise<SandboxHandle>;
  /** Creates a sandbox once; later calls reuse it (even while booting). */
  once(factory: () => Promise<SandboxHandle>): () => Promise<SandboxHandle>;
}

interface Scenario {
  id: string;
  title: string;
  blurb: string;
  mount(api: ScenarioApi): void;
}

const app = document.querySelector<HTMLElement>('#app');
const cleanups: (() => void)[] = [];
let activeSandbox: SandboxHandle | undefined;
let activeScenarioId = '';

const getPanel = (): HTMLElement | null => document.querySelector('#panel');
const getLogList = (): HTMLElement | null => document.querySelector('#logs');
const getStatusEl = (): HTMLElement | null => document.querySelector('#status');
const getMode = (): FrameMode =>
  (document.querySelector<HTMLSelectElement>('#mode')?.value as FrameMode | undefined) ?? 'inline';

function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    const code = value instanceof SandboxError ? ` (code=${value.code})` : '';
    return `${value.name}: ${value.message}${code}`;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function log(level: string, ...parts: unknown[]): void {
  const list = getLogList();
  if (!list) return;
  const row = document.createElement('div');
  row.className = `log log-${level}`;
  row.textContent = `${new Date().toLocaleTimeString()} [${level}] ${parts.map(format).join(' ')}`;
  list.append(row);
  list.scrollTop = list.scrollHeight;
}

function setStatus(text: string): void {
  const status = getStatusEl();
  if (status) status.textContent = text;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  node.append(...children);
  return node;
}

function button(label: string, onClick: () => void | Promise<void>): HTMLButtonElement {
  return el('button', {
    type: 'button',
    class: 'action',
    text: label,
    onclick: () => {
      void Promise.resolve(onClick()).catch((error: unknown) => log('error', error));
    },
  });
}

function output(): HTMLPreElement {
  return el('pre', { class: 'output', text: 'ready' });
}

function row(...children: HTMLElement[]): HTMLDivElement {
  return el('div', { class: 'row' }, children);
}

/** Runs a call and prints either its value or the error into the scenario output pane. */
function show(out: HTMLElement, run: () => Promise<unknown>): () => Promise<void> {
  return async () => {
    try {
      out.textContent = format(await run());
    } catch (error) {
      out.textContent = format(error);
    }
  };
}

function drawCommands(canvas: HTMLCanvasElement) {
  return (commands: unknown): string => {
    const context = canvas.getContext('2d');
    if (!context) return 'no 2d context';
    const list = commands as { x: number; y: number; w: number; h: number; color: string }[];
    for (const command of list) {
      context.fillStyle = command.color;
      context.fillRect(command.x, command.y, command.w, command.h);
    }
    return `${list.length} commands drawn on the host canvas`;
  };
}

async function boot(source: SandboxSource, options: BootOptions = {}): Promise<SandboxHandle> {
  const sandbox = await createSandbox({
    source,
    callTimeoutMs: options.callTimeoutMs ?? 2000,
    onCallTimeout: options.onCallTimeout ?? 'reject',
    onLog: (entry: SandboxLogEntry) => log(entry.level, ...entry.parts),
    ...(options.canvas ? { canvas: options.canvas } : {}),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    ...(getMode() === 'url' ? { frameUrl: '/sandbox-frame.html' } : {}),
  });

  const previous = activeSandbox;
  activeSandbox = sandbox;
  if (previous && previous !== sandbox) void previous.terminate('replaced');

  setStatus(
    `${getMode()} · ${sandbox.id} · origin=${sandbox.info.origin} · methods=${sandbox.info.guestMethods.join(',')}`,
  );
  log('sandbox', `booted ${sandbox.name} (mode=${getMode()}, origin=${sandbox.info.origin})`);

  sandbox.on('error', (payload) => log('error', payload));
  cleanups.push(() => {
    if (activeSandbox === sandbox) activeSandbox = undefined;
    void sandbox.terminate('scenario changed');
  });

  return sandbox;
}

function once(factory: () => Promise<SandboxHandle>): () => Promise<SandboxHandle> {
  let promise: Promise<SandboxHandle> | undefined;
  return () => (promise ??= factory());
}

const scenarios: Scenario[] = [
  {
    id: 'basics',
    title: '1 · Basic calls',
    blurb: 'A module guest exposes methods through the object returned by setup().',
    mount(api) {
      const out = output();
      const sandbox = api.once(() => api.boot({ type: 'module', code: basicsGuest }));

      api.panel.append(
        row(
          button('add(2, 3)', async () => {
            out.textContent = format(await (await sandbox()).call('add', 2, 3));
          }),
          button('computePi(20_000_000)', async () => {
            out.textContent = format(await (await sandbox()).call('computePi', 20_000_000));
          }),
          button('env()', async () => {
            out.textContent = format(await (await sandbox()).call('env'));
          }),
          button('100 concurrent calls', async () => {
            const handle = await sandbox();
            const started = performance.now();
            await Promise.all(
              Array.from({ length: 100 }, (_, index) => handle.call('add', index, index)),
            );
            out.textContent = `100 concurrent calls in ${Math.round(performance.now() - started)}ms`;
          }),
        ),
        out,
      );
    },
  },
  {
    id: 'capabilities',
    title: '2 · Capabilities',
    blurb:
      'The guest calls host functions through ctx.invoke(); one of them draws into a host canvas.',
    mount(api) {
      const out = output();
      const canvas = el('canvas', { class: 'stage', width: 320, height: 140 });
      const sandbox = api.once(() =>
        api.boot(
          { type: 'module', code: capabilityGuest },
          {
            canvas,
            capabilities: {
              echo: (value: unknown) => `host echoes ${String(value)}`,
              now: () => Date.now(),
              draw: drawCommands(canvas),
            },
          },
        ),
      );

      api.panel.append(
        row(
          button('echo("ping")', async () => {
            out.textContent = format(await (await sandbox()).call('echo', 'ping'));
          }),
          button('hostTime()', async () => {
            out.textContent = format(await (await sandbox()).call('hostTime'));
          }),
          button('drawDemo()', async () => {
            out.textContent = format(await (await sandbox()).call('drawDemo'));
          }),
          button(
            'unknown capability',
            show(out, async () => (await sandbox()).call('unknownCapability')),
          ),
        ),
        canvas,
        out,
      );
    },
  },
  {
    id: 'offscreen',
    title: '3 · Offscreen canvas',
    blurb:
      'The guest renders into its own OffscreenCanvas inside the worker; the host only blits frames.',
    mount(api) {
      const out = output();
      const canvas = el('canvas', { class: 'stage', width: 480, height: 220 });
      let current = api.once(() =>
        api.boot({ type: 'module', code: offscreen2dGuest }, { canvas, callTimeoutMs: 4000 }),
      );

      const watch = async (): Promise<SandboxHandle> => {
        const handle = await current();
        handle.on('fps', (payload) => setStatus(`fps≈${String(payload)} · ${handle.id}`));
        return handle;
      };

      api.panel.append(
        row(
          button('start 2D', async () => {
            out.textContent = format(await (await watch()).call('start'));
          }),
          button('start WebGL2', async () => {
            current = api.once(() =>
              api.boot(
                { type: 'module', code: offscreenWebglGuest },
                { canvas, callTimeoutMs: 4000 },
              ),
            );
            out.textContent = format(await (await watch()).call('start'));
          }),
          button('stop', async () => {
            out.textContent = format(await activeSandbox?.call('stop'));
          }),
          button('surface info', async () => {
            out.textContent = format(await activeSandbox?.call('surfaceInfo'));
          }),
          button('resize 320×160', async () => {
            activeSandbox?.resize({ width: 320, height: 160, dpr: 1 });
            out.textContent = format(await activeSandbox?.call('surfaceInfo'));
          }),
          button('resize 480×220', async () => {
            activeSandbox?.resize({ width: 480, height: 220, dpr: 1 });
            out.textContent = format(await activeSandbox?.call('surfaceInfo'));
          }),
        ),
        canvas,
        el('p', {
          class: 'hint',
          text: 'The canvas stays in the host page: transferring an OffscreenCanvas into the sandbox crashes the renderer.',
        }),
        out,
      );
    },
  },
  {
    id: 'events',
    title: '4 · Events & logs',
    blurb: 'Host-driven ticks, guest-emitted events, notify, and console forwarding.',
    mount(api) {
      const out = output();
      const sandbox = api.once(async () => {
        const handle = await api.boot({ type: 'module', code: eventsGuest });
        handle.on('shout', (payload) => log('event', 'shout received', payload));
        return handle;
      });

      let ticks = 0;
      api.panel.append(
        row(
          button('emit tick', async () => {
            ticks += 1;
            (await sandbox()).emit('tick', { n: ticks, at: Date.now() });
            out.textContent = `host emitted tick #${ticks}`;
          }),
          button('notify reset', async () => {
            (await sandbox()).notify('reset');
            out.textContent = 'host sent notify("reset")';
          }),
          button('read stats', async () => {
            out.textContent = format(await (await sandbox()).call('stats'));
          }),
          button('guest shout', async () => {
            out.textContent = format(await (await sandbox()).call('shout', 'hello from the guest'));
          }),
          button('guest logs', async () => {
            out.textContent = format(await (await sandbox()).call('logStuff'));
          }),
        ),
        out,
      );
    },
  },
  {
    id: 'errors',
    title: '5 · Errors',
    blurb: 'Guest throws, unhandled async errors, and a source that fails to parse.',
    mount(api) {
      const out = output();
      const sandbox = api.once(() => api.boot({ type: 'module', code: errorsGuest }));

      api.panel.append(
        row(
          button(
            'throw in method',
            show(out, async () => (await sandbox()).call('boom')),
          ),
          button(
            'unhandled async',
            show(out, async () => (await sandbox()).call('unhandled')),
          ),
          button(
            'rejected promise',
            show(out, async () => (await sandbox()).call('rejects')),
          ),
          button('syntax error source', async () => {
            try {
              await api.boot({ type: 'module', code: brokenGuest });
              out.textContent = 'unexpectedly booted';
            } catch (error) {
              out.textContent = format(error);
            }
          }),
        ),
        out,
      );
    },
  },
  {
    id: 'timeout',
    title: '6 · Timeout & terminate',
    blurb: 'A hanging worker hits the call timeout; terminate then rebuilds cleanly.',
    mount(api) {
      const out = output();
      let hanging = api.once(() =>
        api.boot({ type: 'module', code: spinGuest }, { callTimeoutMs: 800 }),
      );

      api.panel.append(
        row(
          button('spin() with 800ms timeout', async () => {
            const started = performance.now();
            try {
              await (await hanging()).call('spin');
              out.textContent = 'unexpectedly returned';
            } catch (error) {
              out.textContent = `${format(error)}\nrejected after ${Math.round(performance.now() - started)}ms`;
              setStatus('call timed out — worker is hung');
            }
          }),
          button('terminate', async () => {
            const started = performance.now();
            await activeSandbox?.terminate('playground');
            out.textContent = `terminated in ${Math.round(performance.now() - started)}ms`;
            setStatus('terminated');
          }),
          button('rebuild + ok()', async () => {
            hanging = api.once(() =>
              api.boot({ type: 'module', code: spinGuest }, { callTimeoutMs: 800 }),
            );
            out.textContent = format(await (await hanging()).call('ok'));
          }),
        ),
        out,
      );
    },
  },
  {
    id: 'isolation',
    title: '7 · Isolation self-check',
    blurb: 'The guest inspects its own environment: opaque origin, no storage, no network.',
    mount(api) {
      const out = output();
      const sandbox = api.once(() => api.boot({ type: 'module', code: isolationGuest }));

      api.panel.append(
        row(
          button('probe()', async () => {
            out.textContent = format(await (await sandbox()).call('probe'));
          }),
          button('sandbox info', async () => {
            out.textContent = format({ ...(await sandbox()).info });
          }),
        ),
        out,
      );
    },
  },
  {
    id: 'classic',
    title: '8 · Classic script',
    blurb: 'Emscripten-style source: a classic script exposes self.MicaGuest.setup(ctx).',
    mount(api) {
      const out = output();
      const sandbox = api.once(() =>
        api.boot({ type: 'script', code: classicGuest, globalName: 'MicaGuest' }),
      );

      api.panel.append(
        row(
          button('hello("world")', async () => {
            out.textContent = format(await (await sandbox()).call('hello', 'world'));
          }),
        ),
        out,
      );
    },
  },
];

function selectScenario(id: string): void {
  const scenario = scenarios.find((item) => item.id === id);
  const panel = getPanel();
  const nav = document.querySelector<HTMLElement>('#scenarios');
  if (!scenario || !panel || !nav) return;

  while (cleanups.length > 0) cleanups.pop()?.();
  activeSandbox = undefined;
  activeScenarioId = id;

  for (const navButton of nav.querySelectorAll('button')) {
    navButton.classList.toggle('active', navButton.dataset['scenario'] === id);
  }

  panel.replaceChildren(
    el('header', { class: 'panel-header' }, [
      el('h2', { text: scenario.title }),
      el('p', { text: scenario.blurb }),
    ]),
  );

  const api: ScenarioApi = {
    panel,
    mode: getMode,
    log,
    setStatus,
    boot,
    once,
  };

  try {
    scenario.mount(api);
  } catch (error) {
    log('error', error);
  }
}

function renderShell(root: HTMLElement): void {
  root.replaceChildren(
    el('header', { class: 'app-header' }, [
      el('h1', { text: 'Mica sandbox playground' }),
      el('div', { class: 'header-controls' }, [
        el('label', { class: 'mode-picker' }, [
          'frame mode',
          el(
            'select',
            {
              id: 'mode',
              onchange: () => {
                if (activeScenarioId) selectScenario(activeScenarioId);
              },
            },
            [
              el('option', { value: 'inline', text: 'inline (srcdoc)' }),
              el('option', { value: 'url', text: 'url (hosted frame)' }),
            ],
          ),
        ]),
        el('span', { id: 'status', class: 'status', text: 'idle' }),
      ]),
    ]),
    el('div', { class: 'app-body' }, [
      el('nav', { id: 'scenarios', class: 'scenarios' }),
      el('main', { id: 'panel', class: 'panel' }),
      el('aside', { class: 'logs-wrap' }, [
        el('header', { class: 'logs-header' }, [
          el('span', { text: 'Logs' }),
          button('clear', () => getLogList()?.replaceChildren()),
        ]),
        el('div', { id: 'logs', class: 'logs' }),
      ]),
    ]),
  );

  const nav = root.querySelector<HTMLElement>('#scenarios');
  if (!nav) return;
  for (const scenario of scenarios) {
    nav.append(
      el('button', {
        type: 'button',
        class: 'scenario-button',
        'data-scenario': scenario.id,
        text: scenario.title,
        onclick: () => selectScenario(scenario.id),
      }),
    );
  }
}

if (app) {
  renderShell(app);
  selectScenario(scenarios[0]?.id ?? 'basics');
}

window.addEventListener('pagehide', () => {
  while (cleanups.length > 0) cleanups.pop()?.();
  void activeSandbox?.terminate('page hidden');
});
