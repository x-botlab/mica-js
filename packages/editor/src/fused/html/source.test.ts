import { describe, expect, it } from 'vitest';
import type { DeviceLock, UnifiedDeviceManifest } from '@mica-js/document/fused';
import type { IFusedModelClient, IFusedInstancePresentation } from '../runtime/protocol';
import type { IFusedRuntime } from '../runtime/host/types';
import { HtmlViewError } from './protocol';
import { createHtmlViewRuntimeSource, htmlViewDeviceDeclaration } from './source';

const LOCK: DeviceLock = {
  id: 'test:lamp',
  version: '1.0.0',
  integrity: `sha256:${'0'.repeat(64)}`,
};

const PRESENTATION: IFusedInstancePresentation = {
  instanceId: 'instance-1',
  device: 'test:lamp',
  lock: LOCK,
  geometry: {
    sizing: 'flexible',
    bounds: { x: -1, y: -1, width: 8, height: 8 },
    bodyBounds: { x: 0, y: 0, width: 6, height: 6 },
    pins: {},
  },
  view: undefined,
  props: { label: 'lamp' },
  methods: [],
  events: [],
};

function runtimeWith(
  instances: readonly IFusedInstancePresentation[],
  getModel: (instanceId: string) => IFusedModelClient = () => {
    throw new Error('unexpected getModel');
  },
): IFusedRuntime {
  return {
    display: { instances },
    getModel: (instanceId: string) => getModel(instanceId),
  } as unknown as IFusedRuntime;
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof HtmlViewError ? error.code : `unexpected:${String(error)}`;
  }
  return 'resolved';
}

describe('htmlViewDeviceDeclaration', () => {
  const base = {
    publisher: 'test',
    name: 'lamp',
    version: '1.0.0',
    engines: { mica: '^1.0.0' },
    displayName: 'Lamp',
  } as const;

  it('reads views and model presence from the manifest only', () => {
    const withModel = htmlViewDeviceDeclaration({
      ...base,
      pins: {},
      properties: {},
      model: { entry: 'model.js', methods: {}, events: {} },
      view: { serial: { title: 'Serial', entry: 'views/serial/index.html' } },
    } as UnifiedDeviceManifest);
    expect(withModel.hasModel).toBe(true);
    expect(withModel.views['serial']?.title).toBe('Serial');

    const withoutModel = htmlViewDeviceDeclaration({
      ...base,
      pins: {},
      properties: {},
    } as UnifiedDeviceManifest);
    expect(withoutModel.hasModel).toBe(false);
    expect(withoutModel.views).toEqual({});
  });
});

describe('createHtmlViewRuntimeSource', () => {
  it('reports "not mounted" only when the runtime holds no prepared instance', () => {
    const source = createHtmlViewRuntimeSource({
      runtime: runtimeWith([]),
      device: () => ({ views: {}, hasModel: false }),
    });
    expect(source.describe('instance-1')).toBeUndefined();
  });

  it('takes model presence from the declaration, not from the declared surface', () => {
    const source = createHtmlViewRuntimeSource({
      runtime: runtimeWith([PRESENTATION]),
      device: () => ({
        views: { serial: { title: 'Serial', entry: 'views/serial/index.html' } },
        hasModel: true,
      }),
    });
    const instance = source.describe('instance-1');
    expect(instance?.hasModel).toBe(true);
    expect(instance?.methods).toEqual([]);
    expect(instance?.events).toEqual([]);
    expect(instance?.views['serial']?.entry).toBe('views/serial/index.html');
  });

  it('rejects an instance whose device declaration is missing', () => {
    const source = createHtmlViewRuntimeSource({
      runtime: runtimeWith([PRESENTATION]),
      device: () => undefined,
    });
    expect(codeOf(() => source.describe('instance-1'))).toBe('view/unavailable-mode');
  });

  it('propagates a runtime model failure with its code', () => {
    const source = createHtmlViewRuntimeSource({
      runtime: runtimeWith([PRESENTATION], () => {
        throw Object.assign(new Error('No model is mounted.'), { code: 'model/disconnected' });
      }),
      device: () => ({ views: {}, hasModel: true }),
    });
    try {
      source.model('instance-1');
      throw new Error('expected the lookup to throw');
    } catch (error) {
      expect((error as { readonly code?: unknown }).code).toBe('model/disconnected');
    }
  });
});
