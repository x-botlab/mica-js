import { describe, expect, it } from 'vitest';
import { applyCanvasCommand, type CanvasCommand, type CanvasDocument } from '@mica-js/core/canvas';
import type {
  WidgetHost,
  WidgetHostMode,
  WidgetInputEvent,
  WidgetLayers,
  WidgetPublish,
} from '@mica-js/widget';
import type {
  CanvasBindingTargetInfo,
  HostProvider,
  HostProviderCreateOptions,
} from '../host/provider';
import { canvasDocument, widget } from '../test-helpers';
import type { CanvasEditorDiagnostic } from '../types';
import { CanvasEditor, createCanvasEditor, type CanvasEditorOptions } from './canvas-editor';

type Listener = (event: never) => void;

/** Minimal element stand-in: the editor only appends, styles, listens and measures its own root. */
class FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly style: Record<string, string> = {};
  readonly ownerDocument: FakeDocument;
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #capturedPointers = new Set<number>();
  className = '';
  textContent = '';
  tabIndex = -1;
  clientWidth = 0;
  clientHeight = 0;
  width = 0;
  height = 0;
  #parent: FakeElement | undefined;

  constructor(ownerDocument: FakeDocument, tagName: string) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.#parent = this;
      this.children.push(node);
    }
  }

  remove(): void {
    const parent = this.#parent;
    if (parent === undefined) {
      return;
    }
    parent.children.splice(parent.children.indexOf(this), 1);
    this.#parent = undefined;
  }

  addEventListener(type: string, listener: unknown): void {
    const listeners = this.#listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener as Listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: unknown): void {
    this.#listeners.get(type)?.delete(listener as Listener);
  }

  /** Delivers one event to the registered listeners, like the DOM would. */
  emit(type: string, event: object): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener(event as never);
    }
  }

  getContext(): null {
    // No 2D context: the renderer reports `context-unavailable` and draws nothing.
    return null;
  }

  focus(): void {}

  hasPointerCapture(pointerId: number): boolean {
    return this.#capturedPointers.has(pointerId);
  }

  setPointerCapture(pointerId: number): void {
    this.#capturedPointers.add(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.#capturedPointers.delete(pointerId);
  }

  getBoundingClientRect(): {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  } {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
}

class FakeDocument {
  readonly defaultView: FakeWindow;
  readonly created: FakeElement[] = [];

  constructor() {
    this.defaultView = new FakeWindow();
  }

  createElement(tagName: string): FakeElement {
    const element = new FakeElement(this, tagName);
    this.created.push(element);
    return element;
  }

  find(tagName: string): FakeElement {
    const element = this.created.find((candidate) => candidate.tagName === tagName);
    if (element === undefined) {
      throw new Error(`No <${tagName}> was created.`);
    }
    return element;
  }
}

/** Deterministic `requestAnimationFrame`: callbacks only run when the test flushes them. */
class FakeWindow {
  devicePixelRatio = 1;
  readonly #frames = new Map<number, () => void>();
  #nextFrame = 1;

  requestAnimationFrame(callback: () => void): number {
    const id = this.#nextFrame++;
    this.#frames.set(id, callback);
    return id;
  }

  cancelAnimationFrame(id: number): void {
    this.#frames.delete(id);
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

class FakeAudioContext {
  readonly audioWorklet = {};
  closeCalls = 0;

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

/** `WidgetHost` stand-in whose document load the test resolves or rejects by hand. */
class FakeHost {
  mode: WidgetHostMode;
  #document: CanvasDocument = { version: 1, widgets: [] };
  readonly calls: string[] = [];
  readonly loadModes: WidgetHostMode[] = [];
  readonly dispatches: { readonly instanceId: string; readonly event: WidgetInputEvent }[] = [];
  readonly delivers: string[] = [];
  readonly commands: CanvasCommand[] = [];
  readonly layers: WidgetLayers;
  readonly #documentListeners = new Set<(document: CanvasDocument) => void>();
  layerSubscriptions = 0;
  setModeError: unknown;
  resetError: unknown;
  commandError: unknown;
  /** Decision the test made before the editor called `loadDocument`. */
  #decision: { readonly load: boolean; readonly error?: unknown } | undefined;
  #pending:
    | {
        readonly document: CanvasDocument;
        readonly accept: () => void;
        readonly reject: (error: unknown) => void;
      }
    | undefined;

  constructor(mode: WidgetHostMode) {
    this.mode = mode;
    this.layers = {
      list: () => [],
      get: () => undefined,
      subscribe: () => {
        this.layerSubscriptions += 1;
        return () => {
          this.layerSubscriptions -= 1;
        };
      },
    };
  }

  loadDocument(document: CanvasDocument): Promise<void> {
    this.loadModes.push(this.mode);
    // The editor only reaches this after the provider created the host, i.e. a microtask after the
    // constructor returned, so a test decides the outcome before or after the call.
    return new Promise<void>((resolve, reject) => {
      this.#pending = {
        document,
        accept: () => {
          // A real host answers with its own snapshot, not with the caller's object.
          this.#commit({ ...document, widgets: [...document.widgets] });
          resolve();
        },
        reject,
      };
      this.#settle();
    });
  }

  /** Accepts the document handed to `loadDocument`, like a host that validated it. */
  accept(): void {
    this.#decide(true);
  }

  reject(error: unknown): void {
    this.#decide(false, error);
  }

  #decide(load: boolean, error?: unknown): void {
    this.#decision = { load, ...(error === undefined ? {} : { error }) };
    this.#settle();
  }

  #settle(): void {
    const pending = this.#pending;
    const decision = this.#decision;
    if (pending === undefined || decision === undefined) {
      return;
    }
    this.#pending = undefined;
    this.#decision = undefined;
    if (decision.load) {
      pending.accept();
    } else {
      pending.reject(decision.error);
    }
  }

  getDocument(): CanvasDocument {
    return this.#document;
  }

  /** Whether the editor handed the document over and is still waiting for the decision. */
  get hasPendingLoad(): boolean {
    return this.#pending !== undefined;
  }

  getMode(): WidgetHostMode {
    return this.mode;
  }

  async setMode(mode: WidgetHostMode): Promise<void> {
    this.calls.push(`setMode:${mode}`);
    if (this.setModeError !== undefined) {
      throw this.setModeError;
    }
    this.mode = mode;
  }

  async reset(): Promise<void> {
    this.calls.push('reset');
    if (this.resetError !== undefined) {
      throw this.resetError;
    }
  }

  onDocumentChange(listener: (document: CanvasDocument) => void): () => void {
    this.#documentListeners.add(listener);
    return () => {
      this.#documentListeners.delete(listener);
    };
  }

  applyCommand(command: CanvasCommand): void {
    this.commands.push(command);
    if (this.commandError !== undefined) {
      throw this.commandError;
    }
    // A real host commits synchronously and notifies the new snapshot before returning.
    this.#commit(applyCanvasCommand(this.#document, command));
  }

  /** Commits one snapshot and notifies the listeners, like the host does after a change. */
  #commit(document: CanvasDocument): void {
    this.#document = document;
    for (const listener of [...this.#documentListeners]) {
      listener(document);
    }
  }

  dispatch(instanceId: string, event: WidgetInputEvent): void {
    this.dispatches.push({ instanceId, event });
  }

  deliver(instanceId: string): void {
    this.delivers.push(instanceId);
  }

  getLayers(): WidgetLayers {
    return this.layers;
  }

  onPublish(): () => void {
    return () => {};
  }

  receivePublish(publish: WidgetPublish): void {
    void publish;
  }
}

/** In-process {@link HostProvider}: hands the fake host over synchronously and never builds one. */
class FakeHostProvider implements HostProvider {
  readonly host: FakeHost;
  /** How often the editor asked for a host; one editor asks once. */
  creations = 0;
  disposals = 0;
  /** Makes `createWidgetHost` fail, like a provider whose sandbox refused to start. */
  createError: unknown;
  /** Makes `dispose` fail, like a host whose sandbox is already gone. */
  disposeError: unknown;
  readonly createOptions: HostProviderCreateOptions[] = [];
  targets: readonly CanvasBindingTargetInfo[] = [];
  /** How often the editor asked for the endpoints; later calls have to re-read them. */
  targetCalls = 0;

  constructor(host: FakeHost) {
    this.host = host;
  }

  createWidgetHost(options?: HostProviderCreateOptions): WidgetHost {
    this.creations += 1;
    this.createOptions.push(options ?? {});
    if (this.createError !== undefined) {
      throw this.createError;
    }
    return this.host as unknown as WidgetHost;
  }

  async getBindingTargets(): Promise<readonly CanvasBindingTargetInfo[]> {
    this.targetCalls += 1;
    return this.targets;
  }

  async dispose(): Promise<void> {
    this.disposals += 1;
    if (this.disposeError !== undefined) {
      throw this.disposeError;
    }
  }
}

interface Harness {
  readonly host: FakeHost;
  readonly provider: FakeHostProvider;
  readonly container: HTMLElement;
  readonly fakeDocument: FakeDocument;
}

function harness(hostMode: WidgetHostMode): Harness {
  const fakeDocument = new FakeDocument();
  const container = fakeDocument.createElement('div');
  container.clientWidth = 400;
  container.clientHeight = 300;
  // A real CSSStyleDeclaration also reports an empty string for unset properties.
  container.style.touchAction = '';
  const host = new FakeHost(hostMode);
  return {
    host,
    provider: new FakeHostProvider(host),
    container: container as unknown as HTMLElement,
    fakeDocument,
  };
}

function editorOptions(
  harnessed: Harness,
  options: { readonly document: CanvasDocument; readonly mode?: 'edit' | 'simulation' },
): CanvasEditorOptions {
  return {
    container: harnessed.container,
    document: options.document,
    hostProvider: harnessed.provider,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  };
}

function createEditor(
  harnessed: Harness,
  options: { readonly document: CanvasDocument; readonly mode?: 'edit' | 'simulation' },
): CanvasEditor {
  return new CanvasEditor(editorOptions(harnessed, options));
}

function pointerDownEvent(x: number, y: number): object {
  return {
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
    pointerId: 1,
    pointerType: 'mouse',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: () => {},
  };
}

describe('CanvasEditor construction', () => {
  it.each([
    { hostMode: 'simulation', mode: undefined, expected: 'edit' },
    { hostMode: 'simulation', mode: 'edit', expected: 'edit' },
    { hostMode: 'edit', mode: 'simulation', expected: 'simulation' },
  ] as const)(
    'loads in $expected mode when the host starts in $hostMode',
    async ({ hostMode, mode, expected }) => {
      const harnessed = harness(hostMode);
      const editor = createEditor(harnessed, {
        document: canvasDocument(widget('a')),
        ...(mode === undefined ? {} : { mode }),
      });
      harnessed.host.accept();
      await editor.ready;

      expect(harnessed.host.loadModes).toEqual([expected]);
      expect(harnessed.host.getMode()).toBe(expected);
      expect(editor.getMode()).toBe(expected);
      await editor.dispose();
    },
  );

  it('rejects startup without loading when the host refuses the initial mode', async () => {
    const harnessed = harness('simulation');
    harnessed.host.setModeError = new Error('mode refused');
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });

    await expect(editor.ready).rejects.toThrow('mode refused');
    expect(harnessed.host.loadModes).toEqual([]);
    expect(harnessed.container.children).toHaveLength(0);
    await editor.dispose();
  });

  it('mounts nothing until the host accepted the document, then draws the host snapshot', async () => {
    const harnessed = harness('edit');
    const document = canvasDocument(widget('a'));
    const editor = createEditor(harnessed, { document });

    expect(harnessed.container.children).toHaveLength(0);
    const before = editor.getDocument();
    expect(before).toBe(document);

    harnessed.host.accept();
    await editor.ready;

    expect(harnessed.container.children).toHaveLength(1);
    expect(editor.getDocument()).toBe(harnessed.host.getDocument());
    expect(editor.getDocument()).not.toBe(document);

    editor.dispose();
    expect(harnessed.container.children).toHaveLength(0);
  });

  it('rejects `ready` and leaves the container untouched when the host rejects the document', async () => {
    const harnessed = harness('edit');
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });

    harnessed.host.reject(new Error('invalid canvas'));
    await expect(editor.ready).rejects.toThrow('invalid canvas');

    expect(harnessed.container.children).toHaveLength(0);
    expect(harnessed.provider.creations).toBe(1);
    await editor.dispose();
  });

  it('creates the audio context for the provider and closes it on dispose', async () => {
    const harnessed = harness('edit');
    const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      writable: true,
      value: FakeAudioContext,
    });
    let receivedContext: AudioContext | undefined;
    const getAudioWorklet = async (context: AudioContext): Promise<AudioWorkletNode> => {
      receivedContext = context;
      return {} as AudioWorkletNode;
    };

    try {
      const editor = new CanvasEditor({
        ...editorOptions(harnessed, { document: canvasDocument(widget('a')) }),
        getAudioWorklet,
      });
      await Promise.resolve();

      const audio = harnessed.provider.createOptions[0]?.audio;
      expect(audio?.context).toBeInstanceOf(FakeAudioContext);
      expect(audio?.getAudioWorklet).toBe(getAudioWorklet);
      if (audio === undefined) {
        throw new Error('Expected audio options.');
      }
      const worklet = await audio.getAudioWorklet?.(audio.context);
      expect(worklet).toBeDefined();

      harnessed.host.accept();
      await editor.ready;
      await editor.dispose();

      expect(receivedContext).toBe(audio.context);
      expect((audio.context as unknown as FakeAudioContext).closeCalls).toBe(1);
    } finally {
      if (originalAudioContext === undefined) {
        delete (globalThis as { AudioContext?: unknown }).AudioContext;
      } else {
        Object.defineProperty(globalThis, 'AudioContext', originalAudioContext);
      }
    }
  });

  it('waits for an asynchronous provider before handing the document over', async () => {
    const harnessed = harness('edit');
    let release: ((host: WidgetHost) => void) | undefined;
    const provider: HostProvider = {
      createWidgetHost: () =>
        new Promise<WidgetHost>((resolve) => {
          release = resolve;
        }),
      // No device side: this provider binds nothing.
      getBindingTargets: async () => [],
      dispose: async () => {},
    };
    const editor = new CanvasEditor({
      container: harnessed.container,
      document: canvasDocument(widget('a')),
      hostProvider: provider,
    });

    // A provider that has not produced the host yet cannot have received the document.
    expect(harnessed.host.hasPendingLoad).toBe(false);
    expect(harnessed.container.children).toHaveLength(0);

    release?.(harnessed.host as unknown as WidgetHost);
    harnessed.host.accept();
    await editor.ready;

    expect(harnessed.container.children).toHaveLength(1);
    await editor.dispose();
  });

  it('rejects `ready` and disposes the provider when it cannot create a host', async () => {
    const harnessed = harness('edit');
    harnessed.provider.createError = new Error('sandbox refused to start');
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });

    await expect(editor.ready).rejects.toThrow('sandbox refused to start');

    expect(harnessed.container.children).toHaveLength(0);
    await editor.dispose();
    expect(harnessed.provider.disposals).toBe(1);
  });

  it('waits for the load before switching mode', async () => {
    const harnessed = harness('edit');
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });

    const switching = editor.setMode('simulation');
    expect(harnessed.host.calls).toEqual([]);

    harnessed.host.accept();
    await editor.ready;
    await switching;

    expect(editor.getMode()).toBe('simulation');
    expect(harnessed.host.calls).toEqual(['setMode:simulation']);
    editor.dispose();
  });

  it('never mounts when it is disposed before the provider created the host', async () => {
    const harnessed = harness('edit');
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });

    const disposing = editor.dispose();
    harnessed.host.accept();
    await editor.ready;
    await disposing;

    expect(harnessed.container.children).toHaveLength(0);
    expect(harnessed.host.layerSubscriptions).toBe(0);
    expect(harnessed.provider.disposals).toBe(1);
  });

  it('releases listeners and the layer subscription on dispose and disposes the provider', async () => {
    const harnessed = harness('edit');
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });
    harnessed.host.accept();
    await editor.ready;

    expect(harnessed.host.layerSubscriptions).toBe(1);

    const disposing = editor.dispose();

    // The DOM teardown is synchronous; the provider follows in the background.
    expect(harnessed.host.layerSubscriptions).toBe(0);
    expect(harnessed.container.style.touchAction).toBe('');
    await disposing;

    expect(harnessed.provider.disposals).toBe(1);
    expect(harnessed.host.calls).toEqual([]);
  });

  it('disposes the provider once, however often dispose is called', async () => {
    const harnessed = harness('edit');
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });
    harnessed.host.accept();
    await editor.ready;

    await Promise.all([editor.dispose(), editor.dispose()]);
    await editor.dispose();

    expect(harnessed.provider.disposals).toBe(1);
    expect(harnessed.provider.creations).toBe(1);
  });

  it('reports a failing provider teardown instead of rejecting dispose', async () => {
    const diagnostics: CanvasEditorDiagnostic[] = [];
    const harnessed = harness('edit');
    harnessed.provider.disposeError = new Error('sandbox already gone');
    const editor = new CanvasEditor({
      ...editorOptions(harnessed, { document: canvasDocument(widget('a')) }),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    harnessed.host.accept();
    await editor.ready;

    await expect(editor.dispose()).resolves.toBeUndefined();

    // The fake canvas has no 2d context, so the renderer reports first; teardown comes last.
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'canvas-editor/dispose-failed',
    );
  });

  it('drops deliveries that arrive before the provider created the host', async () => {
    const harnessed = harness('edit');
    const document = canvasDocument(
      widget('a', { bindings: { value: { symbol: 'S1', port: 'value' } } }),
    );
    const editor = createEditor(harnessed, { document });

    editor.deliver({ symbol: 'S1', port: 'value' }, 1, 0);
    harnessed.host.accept();
    await editor.ready;
    editor.deliver({ symbol: 'S1', port: 'value' }, 1, 0);

    expect(harnessed.host.delivers).toEqual(['a']);
    await editor.dispose();
  });
});

describe('CanvasEditor.setMode', () => {
  it('switches the host mode so the frame clock follows', async () => {
    const harnessed = harness('edit');
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });
    harnessed.host.accept();
    await editor.ready;

    const switching = editor.setMode('simulation');
    // Input routing has to follow immediately, before the host finished remounting.
    expect(editor.getMode()).toBe('simulation');
    expect(editor.getState().mode).toBe('simulation');
    await switching;

    expect(harnessed.host.calls).toEqual(['setMode:simulation']);
    expect(harnessed.host.getMode()).toBe('simulation');
    editor.dispose();
  });

  it('resets instead of switching when the host already runs the target mode', async () => {
    const harnessed = harness('edit');
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });
    harnessed.host.accept();
    await editor.ready;
    harnessed.host.mode = 'simulation';

    await editor.setMode('simulation');

    expect(harnessed.host.calls).toEqual(['reset']);
    expect(editor.getMode()).toBe('simulation');
    editor.dispose();
  });

  it('reverts to the previous mode when the host rejects the switch', async () => {
    const harnessed = harness('edit');
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });
    harnessed.host.accept();
    await editor.ready;
    harnessed.host.setModeError = new Error('host refused');

    await expect(editor.setMode('simulation')).rejects.toThrow('host refused');

    expect(editor.getMode()).toBe('edit');
    expect(editor.getState().mode).toBe('edit');
    editor.dispose();
  });

  it('does not touch the host when the mode is already in effect', async () => {
    const harnessed = harness('edit');
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });
    harnessed.host.accept();
    await editor.ready;

    await editor.setMode('edit');

    expect(harnessed.host.calls).toEqual([]);
    editor.dispose();
  });

  it('routes pointer input to the host once the editor runs widgets', async () => {
    const harnessed = harness('edit');
    const editor = createEditor(harnessed, {
      document: canvasDocument(widget('a', { width: 100, height: 50 })),
    });
    harnessed.host.accept();
    await editor.ready;
    await editor.setMode('simulation');

    const canvas = harnessed.fakeDocument.find('canvas');
    canvas.emit('pointerdown', pointerDownEvent(10, 10));

    expect(harnessed.host.dispatches).toHaveLength(1);
    expect(harnessed.host.dispatches[0]?.instanceId).toBe('a');
    expect(harnessed.host.dispatches[0]?.event.type).toBe('pointerdown');
    editor.dispose();
  });
});

describe('CanvasEditor.applyCommand', () => {
  it('hands the command to the host and adopts the committed snapshot', async () => {
    const harnessed = harness('edit');
    const changes: CanvasDocument[] = [];
    const editor = new CanvasEditor({
      ...editorOptions(harnessed, { document: canvasDocument(widget('a')) }),
      onChange: (document) => changes.push(document),
    });
    harnessed.host.accept();
    await editor.ready;
    // Only committed changes reach `onChange`; the initial load is not one.
    changes.length = 0;

    editor.applyCommand({ type: 'remove-instance', instanceId: 'a' });

    expect(harnessed.host.commands).toEqual([{ type: 'remove-instance', instanceId: 'a' }]);
    expect(editor.getDocument()).toBe(harnessed.host.getDocument());
    expect(editor.getDocument().widgets).toEqual([]);
    expect(changes).toEqual([harnessed.host.getDocument()]);
    editor.dispose();
  });

  it('reports a rejected command and keeps drawing the host snapshot', async () => {
    const diagnostics: CanvasEditorDiagnostic[] = [];
    const harnessed = harness('edit');
    const editor = new CanvasEditor({
      ...editorOptions(harnessed, { document: canvasDocument(widget('a')) }),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    harnessed.host.accept();
    await editor.ready;
    const before = editor.getDocument();
    harnessed.host.commandError = new Error('unknown instance');

    editor.applyCommand({ type: 'remove-instance', instanceId: 'missing' });

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'canvas-editor/command-failed',
    );
    expect(editor.getDocument()).toBe(before);
    editor.dispose();
  });

  it('drops commands that arrive before the initial load settled', async () => {
    const harnessed = harness('edit');
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });

    editor.applyCommand({ type: 'remove-instance', instanceId: 'a' });
    await Promise.resolve();

    expect(harnessed.host.commands).toEqual([]);
    harnessed.host.accept();
    await editor.ready;
    editor.dispose();
  });

  it('ignores commands once disposed', async () => {
    const harnessed = harness('edit');
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });
    harnessed.host.accept();
    await editor.ready;
    await editor.dispose();

    editor.applyCommand({ type: 'remove-instance', instanceId: 'a' });

    expect(harnessed.host.commands).toEqual([]);
  });
});

describe('CanvasEditor.loadDocument', () => {
  it('loads the document into the host and draws the snapshot it committed', async () => {
    const harnessed = harness('edit');
    const changes: CanvasDocument[] = [];
    const editor = new CanvasEditor({
      ...editorOptions(harnessed, { document: canvasDocument(widget('a')) }),
      onChange: (document) => changes.push(document),
    });
    harnessed.host.accept();
    await editor.ready;
    changes.length = 0;

    const loading = editor.loadDocument(canvasDocument(widget('b')));
    harnessed.host.accept();
    await loading;

    expect(editor.getDocument()).toBe(harnessed.host.getDocument());
    expect(editor.getDocument().widgets.map((instance) => instance.id)).toEqual(['b']);
    expect(changes).toEqual([harnessed.host.getDocument()]);
    editor.dispose();
  });

  it('waits for the initial document before loading the next one', async () => {
    const harnessed = harness('edit');
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });

    const loading = editor.loadDocument(canvasDocument(widget('b')));
    // The first document reaches the host one microtask after construction; the second waits.
    await Promise.resolve();
    expect(harnessed.host.hasPendingLoad).toBe(true);

    harnessed.host.accept();
    await editor.ready;
    await Promise.resolve();
    expect(harnessed.host.hasPendingLoad).toBe(true);

    harnessed.host.accept();
    await loading;

    expect(editor.getDocument().widgets.map((instance) => instance.id)).toEqual(['b']);
    editor.dispose();
  });

  it('drops selection ids the new document does not contain', async () => {
    const harnessed = harness('edit');
    const selections: (readonly string[])[] = [];
    const editor = new CanvasEditor({
      ...editorOptions(harnessed, {
        document: canvasDocument(widget('a'), widget('b')),
      }),
      onSelectionChange: (ids) => selections.push(ids),
    });
    harnessed.host.accept();
    await editor.ready;
    editor.setSelection(['a', 'b']);
    selections.length = 0;

    const loading = editor.loadDocument(canvasDocument(widget('b')));
    harnessed.host.accept();
    await loading;

    expect(editor.getState().selection).toEqual(['b']);
    expect(selections).toEqual([['b']]);
    editor.dispose();
  });

  it('rejects and keeps the previous snapshot when the host rejects the document', async () => {
    const harnessed = harness('edit');
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });
    harnessed.host.accept();
    await editor.ready;
    const before = editor.getDocument();

    const loading = editor.loadDocument(canvasDocument(widget('b')));
    harnessed.host.reject(new Error('invalid canvas'));

    await expect(loading).rejects.toThrow('invalid canvas');
    expect(editor.getDocument()).toBe(before);
    expect(editor.getDocument().widgets.map((instance) => instance.id)).toEqual(['a']);
    editor.dispose();
  });

  it('does nothing once disposed', async () => {
    const harnessed = harness('edit');
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });
    harnessed.host.accept();
    await editor.ready;
    await editor.dispose();

    await editor.loadDocument(canvasDocument(widget('b')));

    expect(harnessed.host.hasPendingLoad).toBe(false);
  });

  it('resolves instead of rejecting when the editor is disposed mid-load', async () => {
    const harnessed = harness('edit');
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });
    harnessed.host.accept();
    await editor.ready;

    const loading = editor.loadDocument(canvasDocument(widget('b')));
    const disposing = editor.dispose();
    harnessed.host.reject(new Error('host disposed'));

    await expect(loading).resolves.toBeUndefined();
    await disposing;
  });
});

describe('CanvasEditor.getBindingTargets', () => {
  const targets: readonly CanvasBindingTargetInfo[] = [
    { symbol: 'S1', designator: 'S1', port: 'pressCount', direction: 'output', type: 'number' },
  ];

  it('answers with the endpoints the provider reports once the document loaded', async () => {
    const harnessed = harness('edit');
    harnessed.provider.targets = targets;
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });
    harnessed.host.accept();
    await editor.ready;

    await expect(editor.getBindingTargets()).resolves.toEqual(targets);
    expect(harnessed.provider.targetCalls).toBe(1);
    editor.dispose();
  });

  it('waits for the document to load before asking the provider', async () => {
    const harnessed = harness('edit');
    harnessed.provider.targets = targets;
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });

    const asking = editor.getBindingTargets();
    expect(harnessed.provider.targetCalls).toBe(0);

    harnessed.host.accept();
    await expect(asking).resolves.toEqual(targets);
    expect(harnessed.provider.targetCalls).toBe(1);
    editor.dispose();
  });

  it('resolves with an empty list once disposed', async () => {
    const harnessed = harness('edit');
    harnessed.provider.targets = targets;
    const editor = createEditor(harnessed, { document: canvasDocument(widget('a')) });
    harnessed.host.accept();
    await editor.ready;
    await editor.dispose();

    await expect(editor.getBindingTargets()).resolves.toEqual([]);
    expect(harnessed.provider.targetCalls).toBe(0);
  });
});

describe('createCanvasEditor', () => {
  it('resolves to the mounted editor once the host accepted the document', async () => {
    const harnessed = harness('edit');
    const creating = createCanvasEditor(
      editorOptions(harnessed, { document: canvasDocument(widget('a')) }),
    );

    // Same ordering as the constructor: nothing is mounted while the host loads.
    expect(harnessed.container.children).toHaveLength(0);

    harnessed.host.accept();
    const editor = await creating;

    expect(editor).toBeInstanceOf(CanvasEditor);
    expect(harnessed.container.children).toHaveLength(1);
    expect(editor.getDocument()).toBe(harnessed.host.getDocument());

    editor.dispose();
    expect(harnessed.container.children).toHaveLength(0);
  });

  it('rejects with the host error and mounts nothing', async () => {
    const harnessed = harness('edit');
    const creating = createCanvasEditor(
      editorOptions(harnessed, { document: canvasDocument(widget('a')) }),
    );

    harnessed.host.reject(new Error('invalid canvas'));
    await expect(creating).rejects.toThrow('invalid canvas');

    expect(harnessed.container.children).toHaveLength(0);
    expect(harnessed.host.layerSubscriptions).toBe(0);
  });
});
