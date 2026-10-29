import {
  createDeviceRegistry,
  parseSchematic,
  type SchematicDocument,
} from '@mica-js/core/schematic';

type Listener = (event: never) => void;

type FakeStyle = {
  [name: string]: unknown;
  setProperty(name: string, value: string): void;
};

/** Minimal element stand-in: the editor only appends, styles, listens and measures its own DOM. */
export class FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly style: FakeStyle;
  readonly ownerDocument: FakeDocument;
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #attributes = new Map<string, string>();
  readonly #capturedPointers = new Set<number>();
  readonly classList: { add(...names: string[]): void };
  className = '';
  textContent = '';
  tabIndex = -1;
  type = '';
  disabled = false;
  title = '';
  width = 0;
  height = 0;
  clientWidth = 800;
  clientHeight = 600;
  #parent: FakeElement | undefined;

  constructor(ownerDocument: FakeDocument, tagName: string) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName;
    const style: FakeStyle = {
      setProperty(name, value) {
        style[name] = value;
      },
    };
    this.style = style;
    this.classList = {
      add: (...names) => {
        const current = new Set(this.className.split(' ').filter((name) => name.length > 0));
        for (const name of names) {
          current.add(name);
        }
        this.className = [...current].join(' ');
      },
    };
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

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
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

  setPointerCapture(pointerId: number): void {
    this.#capturedPointers.add(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.#capturedPointers.delete(pointerId);
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.#capturedPointers.has(pointerId);
  }

  contains(node: unknown): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }

  getContext(): null {
    // No 2D context: the renderer draws nothing, which is all these tests need.
    return null;
  }

  focus(): void {}

  getBoundingClientRect(): {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  } {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
}

export class FakeDocument {
  readonly defaultView = { devicePixelRatio: 1 };
  readonly created: FakeElement[] = [];
  readonly #listeners = new Map<string, Set<Listener>>();

  createElement(tagName: string): FakeElement {
    const element = new FakeElement(this, tagName);
    this.created.push(element);
    return element;
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return this.createElement(tagName);
  }

  addEventListener(type: string, listener: unknown): void {
    const listeners = this.#listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener as Listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: unknown): void {
    this.#listeners.get(type)?.delete(listener as Listener);
  }

  find(tagName: string): FakeElement | undefined {
    return this.created.find((candidate) => candidate.tagName === tagName);
  }
}

export class FakeResizeObserver {
  readonly targets: FakeElement[] = [];
  disconnected = false;

  constructor(readonly callback: () => void) {}

  observe(target: FakeElement): void {
    this.targets.push(target);
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

/** Installs the two browser globals the editor reads; returns the restore function. */
export function installDomGlobals(): () => void {
  const global = globalThis as {
    ResizeObserver?: unknown;
  };
  const previous = global.ResizeObserver;
  global.ResizeObserver = FakeResizeObserver;
  return () => {
    if (previous === undefined) {
      delete global.ResizeObserver;
      return;
    }
    global.ResizeObserver = previous;
  };
}

export interface FakeContainer {
  readonly document: FakeDocument;
  readonly container: HTMLElement;
}

export function createContainer(): FakeContainer {
  const document = new FakeDocument();
  const container = document.createElement('div');
  return { document, container: container as unknown as HTMLElement };
}

export const devices = createDeviceRegistry([
  {
    packageId: 'pkg',
    devices: [
      {
        id: 'mcu',
        displayName: 'MCU',
        designatorPrefix: 'U',
        raw: {
          pins: { A: { side: 'left' }, B: { side: 'right' } },
          properties: {
            label: { type: 'string', default: 'U1' },
            speed: { type: 'number', default: 72, min: 1, max: 170, unit: 'MHz' },
          },
        },
      },
    ],
  },
]);

export function documentOf(sheet: {
  symbols?: readonly unknown[];
  wires?: readonly unknown[];
  junctions?: readonly unknown[];
}): SchematicDocument {
  return parseSchematic({
    version: 1,
    sheet: {
      symbols: sheet.symbols ?? [],
      wires: sheet.wires ?? [],
      junctions: sheet.junctions ?? [],
    },
  });
}

export const symbolId = '00000003-41e6-4a4c-869a-82a4cd304787';

export function documentWithSymbol(): SchematicDocument {
  return documentOf({
    symbols: [{ id: symbolId, device: 'pkg:mcu', x: 0, y: 0, rotation: 0 }],
  });
}
