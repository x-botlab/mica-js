import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { DisposableStore, Emitter } from '@mica-js/core/lifecycle';
import { timePs } from '@mica-js/core';
import type {
  DeviceLock,
  Endpoint,
  FusedDocument,
  InstanceViewLayout,
  Point2D,
} from '@mica-js/document/fused';
import { parseFusedDocument } from '@mica-js/document/fused';
import { openDevicePackage, resolveInstanceProperties } from '@mica-js/sdk/fused';
import { createContextKeyService } from './context';
import { FusedDocumentSession } from './document';
import {
  addLabel,
  addPlacedReference,
  addWire,
  rotateTargets,
  setLabelName,
  setReferenceLabelName,
  setReferenceRotation,
  setReferenceVoltage,
  setTextOffset,
  setInstanceProperty,
} from './document/edits';
import {
  materializeAnchor,
  moveLabel,
  moveReference,
  moveWireSegment,
  routeDocumentWires,
} from './wiring';
import { ContributionRegistry } from './contributions/registry';
import { findBodyOverlaps } from './canvas/geometry';
import { createHtmlViewHost, type IHtmlViewHost } from './html';
import { resolveViewLayout } from './views/layout';
import { normalizeTheme, type WorkbenchTheme } from './theme';
import { createSimulationControl } from './simulation';
import { createFusedRuntime, type IFusedRuntime } from './runtime';
import type { IWorkbenchAccessProvider } from './providers';
import type {
  IWorkbench,
  IWorkbenchCommandMap,
  IWorkbenchContributions,
  IWorkbenchDiagnostic,
  IWorkbenchExtensionContext,
  IWorkbenchOptions,
  IWorkbenchState,
  IWorkbenchTarget,
  WorkbenchCommandArgs,
  WorkbenchMode,
  WorkbenchTool,
} from './types';
import { WorkbenchPart, type IWorkbenchUI } from './parts/workbench-part';
import type { ICanvasHandle, IViewInput } from './parts/canvas-part';
import './styles/workbench.css';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'workbench/operation-failed';
}

function validateViewBase(template: string): void {
  const url = new URL(template.replace('${id}', 'mica-view'));
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !template.endsWith('/') ||
    template.split('${id}').length !== 2 ||
    !new URL(template).hostname.split('.').includes('${id}')
  ) {
    throw new Error(
      'viewBaseUrlTemplate must be an absolute HTTP(S) directory URL with one ${id} hostname label',
    );
  }
}

async function decodeResourceImage(
  bytes: Uint8Array,
  name: string,
): Promise<ImageBitmap | HTMLImageElement> {
  const svg = name.toLowerCase().endsWith('.svg');
  const blob = new Blob([bytes.slice().buffer], {
    type: svg ? 'image/svg+xml' : 'application/octet-stream',
  });
  if (!svg) return createImageBitmap(blob);
  const source = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(source);
  }
}

export async function createWorkbench(options: IWorkbenchOptions): Promise<IWorkbench> {
  validateViewBase(options.viewBaseUrlTemplate);
  function validateTheme(value: WorkbenchTheme | undefined) {
    const result = normalizeTheme(value);
    for (const [token, color] of Object.entries(result.colors ?? {}))
      if (!CSS.supports('color', color))
        throw new Error(`Invalid CSS color for ${token}: ${color}`);
    return result;
  }
  let theme = validateTheme(options.theme);
  const step = options.step ?? timePs(10_000_000);
  if (!Number.isSafeInteger(step) || step <= 0)
    throw new Error('Workbench step must be a positive integer number of picoseconds');
  const disposables = new DisposableStore();
  const abort = new AbortController();
  const content = disposables.add(new Emitter<FusedDocument>());
  const selectionChanged = disposables.add(new Emitter<readonly IWorkbenchTarget[]>());
  const stateChanged = disposables.add(new Emitter<IWorkbenchState>());
  const diagnosticsChanged = disposables.add(new Emitter<IWorkbenchDiagnostic>());
  const openProject = disposables.add(new Emitter<{ readonly projectId: string }>());
  const uiChanged = disposables.add(new Emitter<void>());
  const defaultAccessChanged = disposables.add(new Emitter<void>());
  const access: IWorkbenchAccessProvider = {
    onDidChange: options.accessProvider?.onDidChange ?? defaultAccessChanged.event,
    async evaluateDocument(context) {
      const decision = (await options.accessProvider?.evaluateDocument(context)) ?? {
        edit: { allowed: true as const },
        run: { allowed: true as const },
      };
      return {
        ...decision,
        edit: options.readOnly
          ? {
              allowed: false,
              code: 'document/read-only',
              message: 'The host opened this document read-only',
            }
          : decision.edit,
      };
    },
    async canAddDevice(context) {
      return (await options.accessProvider?.canAddDevice(context)) ?? { allowed: true };
    },
  };
  const rootContext = disposables.add(
    createContextKeyService({
      owner: 'workbench',
      reservedPrefixes: [
        'workbench.',
        'editor.',
        'document.',
        'history.',
        'selection.',
        'viewContainer.',
        'canvas.',
      ],
    }),
  );
  const contextKeys = disposables.add(rootContext.createScope());
  const keys = {
    mode: rootContext.createKey<WorkbenchMode>('workbench.mode', 'edit'),
    busy: rootContext.createKey('workbench.busy', false),
    editable: rootContext.createKey('document.editable', false),
    dirty: rootContext.createKey('document.dirty', false),
    undo: rootContext.createKey('history.canUndo', false),
    redo: rootContext.createKey('history.canRedo', false),
    selection: rootContext.createKey('selection.count', 0),
    container: rootContext.createKey('viewContainer.active', ''),
    focus: rootContext.createKey('canvas.focused', false),
  };
  let documentSession: FusedDocumentSession;
  try {
    documentSession = await FusedDocumentSession.open({
      document: options.document,
      ...(options.saveDocument === undefined ? {} : { saveDocument: options.saveDocument }),
      devices: options.deviceProvider,
      access,
    });
  } catch (error) {
    disposables.dispose();
    throw error;
  }

  let disposed = false;
  let disposal: Promise<void> | undefined;
  let mode: WorkbenchMode = 'edit';
  let busy = false;
  let tool: WorkbenchTool = 'select';
  let labelName = 'NET1';
  let activeContainer: string | undefined;
  let selection: readonly IWorkbenchTarget[] = Object.freeze([]);
  let placement: DeviceLock | undefined;
  let placementRotation = 0;
  let canvas: ICanvasHandle | undefined;
  let runtime: IFusedRuntime | undefined;
  let runtimeDocument: FusedDocument | undefined;
  let runtimeGeneration = 0;
  let htmlViews: IHtmlViewHost | undefined;
  const transientLayouts = new Map<string, InstanceViewLayout | undefined>();
  let transition = Promise.resolve();
  let presentation = Promise.resolve();
  let presentationSignature = '';
  let version = 0;
  const simulation = disposables.add(
    createSimulationControl(() => {
      if (mode === 'run') update();
    }),
  );
  const images = new Map<string, ImageBitmap | HTMLImageElement>();
  const imageLocks = new Map<string, string>();
  const overlays = new Map<string, ImageBitmap>();
  const diagnostics: IWorkbenchDiagnostic[] = [];
  const mount = globalThis.document.createElement('div');
  mount.style.cssText = 'width:100%;height:100%;min-height:0;min-width:0;';
  const environment = globalThis.document.createElement('div');
  environment.hidden = true;
  const root = createRoot(mount);
  let registry: ContributionRegistry;
  let state = computeState();

  function assertReady(): void {
    if (disposed) throw new Error('Workbench is disposed');
  }
  function computeState(): IWorkbenchState {
    const value = documentSession.getState();
    return Object.freeze({
      mode,
      simulationStatus: mode === 'run' ? simulation.status : undefined,
      busy,
      dirty: value.dirty,
      readOnly: value.readOnly,
      canUndo: value.canUndo,
      canRedo: value.canRedo,
      tool,
      activeContainer,
    });
  }
  function update(): void {
    if (disposed) return;
    const next = computeState();
    const changed = JSON.stringify(next) !== JSON.stringify(state);
    state = next;
    rootContext.batch(() => {
      keys.mode.set(mode);
      keys.busy.set(busy);
      keys.editable.set(documentSession.getState().canEditContent && mode === 'edit' && !busy);
      keys.dirty.set(state.dirty);
      keys.undo.set(state.canUndo);
      keys.redo.set(state.canRedo);
      keys.selection.set(selection.length);
      keys.container.set(activeContainer ?? '');
    });
    version++;
    uiChanged.fire();
    if (changed) stateChanged.fire(state);
  }
  const report = (diagnostic: IWorkbenchDiagnostic): void => {
    if (disposed) return;
    if (
      diagnostics.some(
        (value) =>
          value.code === diagnostic.code &&
          value.message === diagnostic.message &&
          value.instanceId === diagnostic.instanceId,
      )
    )
      return;
    diagnostics.push(Object.freeze({ ...diagnostic }));
    diagnosticsChanged.fire(diagnostic);
    update();
  };
  const error = (reason: unknown): void =>
    report({ code: errorCode(reason), message: errorMessage(reason), severity: 'error' });
  function refreshLayoutDiagnostics(): void {
    const retained = diagnostics.filter((item) => item.code !== 'layout/body-overlap');
    diagnostics.splice(0, diagnostics.length, ...retained);
    for (const { first, second } of findBodyOverlaps(
      documentSession.getDocument(),
      documentSession.getDevices().getLoadedDevices(),
    ))
      report({
        code: 'layout/body-overlap',
        message: `${first.designator ?? first.id} overlaps ${second.designator ?? second.id}`,
        severity: 'warning',
        instanceId: first.id,
      });
  }
  function setSelection(targets: readonly IWorkbenchTarget[]): void {
    assertReady();
    const doc = documentSession.getDocument();
    const seen = new Set<string>();
    const lists = {
      instance: doc.instances,
      wire: doc.wires,
      node: doc.nodes,
      label: doc.labels,
      reference: doc.references,
    };
    for (const target of targets) {
      if (!lists[target.kind]?.some((item) => item.id === target.id))
        throw new Error(`Unknown selection target: ${target.kind}/${target.id}`);
      if (seen.has(target.id)) throw new Error(`Duplicate selection target: ${target.id}`);
      seen.add(target.id);
    }
    const previous =
      selection.length === 1 && selection[0]?.kind === 'instance' ? selection[0].id : undefined;
    selection = Object.freeze(targets.map((target) => Object.freeze({ ...target })));
    const single =
      selection.length === 1 && selection[0]?.kind === 'instance' ? selection[0].id : undefined;
    if (previous !== undefined && previous !== single) {
      const instance = doc.instances.find((item) => item.id === previous);
      const manifest =
        instance === undefined
          ? undefined
          : documentSession.getDevices().getLoaded(instance.device)?.manifest;
      if (manifest !== undefined)
        for (const view of viewLayout(previous).views)
          if (view.location === 'sidebar') htmlViews?.close(previous, view.viewId);
    }
    for (const view of htmlViews?.views ?? [])
      if (view.location === 'sidebar' && view.instanceId !== single) view.close();
    selectionChanged.fire(selection);
    update();
  }
  function clearOverlays(): void {
    for (const image of overlays.values()) image.close();
    overlays.clear();
  }
  async function releaseRuntime(): Promise<void> {
    htmlViews?.closeAll();
    runtimeGeneration++;
    simulation.detach();
    const previous = runtime;
    runtimeDocument = undefined;
    runtime = undefined;
    clearOverlays();
    await previous?.dispose();
  }
  async function loadImages(): Promise<void> {
    for (const [id, device] of documentSession.getDevices().getLoadedDevices()) {
      if (imageLocks.get(id) === device.lock.integrity) continue;
      const path = device.geometry.bodyImage;
      if (path === undefined) {
        imageLocks.set(id, device.lock.integrity);
        continue;
      }
      const bytes = await device.files.read(path);
      const image = await decodeResourceImage(bytes, path);
      if (disposed) {
        if (image instanceof ImageBitmap) image.close();
        return;
      }
      const previous = images.get(id);
      if (previous instanceof ImageBitmap) previous.close();
      images.set(id, image);
      imageLocks.set(id, device.lock.integrity);
    }
  }
  async function createRuntime(targetMode: WorkbenchMode): Promise<IFusedRuntime | undefined> {
    const generation = ++runtimeGeneration;
    const document = documentSession.getDocument();
    const devices = documentSession.getDevices().getLoadedDevices();
    if (
      targetMode === 'edit' &&
      !document.instances.some((instance) => {
        const manifest = devices.get(instance.device)?.manifest;
        return (
          manifest?.view2d?.entry !== undefined ||
          Object.values(manifest?.properties ?? {}).some((property) => property.type === 'program')
        );
      })
    )
      return undefined;
    const result = await createFusedRuntime({
      ...(options.audio === undefined ? {} : { audio: options.audio }),
      document,
      registry: options.deviceProvider,
      step,
      mode: targetMode,
      container: environment,
      ...(options.programs === undefined ? {} : { programs: options.programs }),
      resolveResource: (request) => {
        if (request.reference.mode !== 'asset' || options.assetProvider === undefined)
          throw new Error('No asset provider is configured');
        return options.assetProvider.read(request.reference.assetId, abort.signal);
      },
      onDiagnostic: (diagnostic) => {
        if (generation !== runtimeGeneration) return;
        report({
          code: diagnostic.code,
          message: diagnostic.message,
          severity: 'error',
          ...(diagnostic.instanceId === undefined ? {} : { instanceId: diagnostic.instanceId }),
        });
      },
      onOverlay: (frame) => {
        if (disposed || generation !== runtimeGeneration) {
          frame.bitmap.close();
          return;
        }
        overlays.get(frame.instanceId)?.close();
        overlays.set(frame.instanceId, frame.bitmap);
        update();
      },
      measure: (instance) => {
        const geometry = devices.get(instance.device)?.geometry;
        if (geometry === undefined) throw new Error(`Missing geometry for ${instance.instanceId}`);
        const scale = (canvas?.scale ?? 12) * (globalThis.devicePixelRatio || 1);
        return {
          width: Math.max(1, Math.ceil(geometry.bounds.width * scale)),
          height: Math.max(1, Math.ceil(geometry.bounds.height * scale)),
          scale,
        };
      },
    });
    if (disposed || generation !== runtimeGeneration) {
      await result.dispose();
      throw new Error('Workbench was disposed during runtime preparation');
    }
    runtimeDocument = document;
    return result;
  }
  function refreshPresentation(): void {
    presentation = presentation
      .then(async () => {
        if (disposed) return;
        await loadImages();
        if (disposed) return;
        if (mode === 'edit' && !busy) {
          const signature = JSON.stringify([
            documentSession.getDocument().dependencies,
            documentSession
              .getDocument()
              .instances.map((instance) => [
                instance.id,
                instance.device,
                instance.properties,
                instance.placement.width,
                instance.placement.height,
              ]),
          ]);
          if (signature !== presentationSignature) {
            await releaseRuntime();
            runtime = await createRuntime('edit');
            presentationSignature = signature;
          }
        }
        update();
      })
      .catch(error);
  }
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = transition.then(operation);
    transition = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  function controlSimulation(operation: 'pause' | 'resume'): Promise<void> {
    return enqueue(async () => {
      assertReady();
      if (mode !== 'run') throw new Error(`simulation.${operation} requires Run mode`);
      await simulation[operation]();
    });
  }
  async function setMode(next: WorkbenchMode): Promise<void> {
    assertReady();
    if (next !== 'edit' && next !== 'run')
      throw new Error(`Invalid workbench mode: ${String(next)}`);
    return enqueue(async () => {
      assertReady();
      if (next === mode) return;
      busy = true;
      placement = undefined;
      tool = 'select';
      update();
      try {
        await presentation;
        if (next === 'run') {
          await documentSession.setRunning(true);
          await releaseRuntime();
          runtime = await createRuntime('run');
          if (runtime === undefined) throw new Error('Run mode requires a mounted runtime');
          simulation.attach(runtime);
          await documentSession.refreshAccess();
          const permission = documentSession.getAccess().run;
          if (!permission.allowed) throw new Error(permission.message);
          mode = 'run';
        } else {
          try {
            await releaseRuntime();
          } finally {
            await documentSession.setRunning(false);
            mode = 'edit';
            presentationSignature = '';
          }
        }
      } catch (reason) {
        const failures = [reason];
        if (next === 'run') {
          try {
            await releaseRuntime();
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
          try {
            await documentSession.setRunning(false);
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
          mode = 'edit';
          presentationSignature = '';
        }
        const failure =
          failures.length === 1
            ? reason
            : new AggregateError(failures, 'Failed to enter and release the run session');
        error(failure);
        throw failure;
      } finally {
        busy = false;
        update();
        if (mode === 'edit') refreshPresentation();
      }
    });
  }
  function assertEditable(): void {
    assertReady();
    if (busy || mode !== 'edit' || !documentSession.getState().canEditContent)
      throw new Error('Document is not editable');
  }
  async function placeDevice(device: DeviceLock): Promise<void> {
    assertEditable();
    await documentSession.refreshAccess();
    assertEditable();
    const dependency = documentSession.getDocument().dependencies[device.id];
    if (
      dependency !== undefined &&
      (dependency.version !== device.version || dependency.integrity !== device.integrity)
    )
      throw new Error(`A different release of ${device.id} is already locked by this document`);
    const decision = await access.canAddDevice({
      document: documentSession.getDocument(),
      device,
    });
    if (!decision.allowed) throw new Error(decision.message);
    await documentSession.getDevices().get(device);
    await loadImages();
    assertEditable();
    placement = { ...device };
    placementRotation = 0;
    tool = 'select';
    if (options.container.clientWidth <= 720) activeContainer = undefined;
    update();
  }
  function viewLayout(instanceId: string): InstanceViewLayout {
    const instance = documentSession.getDocument().instances.find((item) => item.id === instanceId);
    const manifest =
      instance === undefined
        ? undefined
        : documentSession.getDevices().getLoaded(instance.device)?.manifest;
    if (instance === undefined || manifest === undefined)
      throw new Error(`Unknown device instance: ${instanceId}`);
    return resolveViewLayout(
      transientLayouts.has(instanceId) ? transientLayouts.get(instanceId) : instance.viewLayout,
      manifest,
      options.container.clientHeight,
    );
  }
  async function changeViewLayout(
    instanceId: string,
    layout: InstanceViewLayout | undefined,
  ): Promise<void> {
    assertReady();
    viewLayout(instanceId);
    if (documentSession.getState().canEditLayout) {
      await documentSession.setViewLayout(instanceId, layout);
      transientLayouts.delete(instanceId);
    } else {
      const document = documentSession.getDocument();
      const candidate = parseFusedDocument(
        JSON.stringify({
          ...document,
          instances: document.instances.map((instance) =>
            instance.id === instanceId ? { ...instance, viewLayout: layout } : instance,
          ),
        }),
      );
      transientLayouts.set(
        instanceId,
        candidate.instances.find((instance) => instance.id === instanceId)?.viewLayout,
      );
    }
    for (const handle of htmlViews?.views ?? []) {
      if (handle.instanceId !== instanceId) continue;
      const target = viewLayout(instanceId).views.find((view) => view.viewId === handle.viewId);
      if (target === undefined) handle.close();
      else {
        handle.setLocation(target.location);
        handle.setVisible(!target.collapsed || target.location === 'floating');
      }
    }
    update();
  }
  async function openView(
    instanceId: string,
    viewId: string,
    location?: 'sidebar' | 'floating',
  ): Promise<void> {
    assertReady();
    if (mode !== 'run' || busy || htmlViews === undefined)
      throw new Error('Device HTML views are available in Run mode');
    const layout = viewLayout(instanceId);
    const target = layout.views.find((view) => view.viewId === viewId);
    if (target === undefined) throw new Error(`Unknown device view: ${viewId}`);
    const nextLocation = location ?? target.location;
    if (target.collapsed || target.location !== nextLocation)
      await changeViewLayout(instanceId, {
        ...layout,
        views: layout.views.map((view) =>
          view.viewId === viewId ? { ...view, collapsed: false, location: nextLocation } : view,
        ),
      });
    if (nextLocation === 'sidebar') {
      setSelection([{ kind: 'instance', id: instanceId }]);
      activeContainer = 'mica.properties';
    }
    const handle = await htmlViews.open({ instanceId, viewId, location: nextLocation });
    handle.setLocation(nextLocation);
    handle.setVisible(true);
    update();
    handle.focus();
  }
  const handlers: {
    [K in keyof IWorkbenchCommandMap]: (
      params: IWorkbenchCommandMap[K]['params'],
    ) => Promise<IWorkbenchCommandMap[K]['result']> | IWorkbenchCommandMap[K]['result'];
  } = {
    'workbench.openContainer': async ({ id, focus }) => {
      const container = registry.containers.find((value) => value.id === id);
      if (container === undefined || !registry.visible(container))
        throw new Error(`Unavailable view container: ${id}`);
      activeContainer = id;
      update();
      if (focus)
        requestAnimationFrame(() =>
          mount
            .querySelector<HTMLElement>(
              '.mica-wb-sidebar input, .mica-wb-sidebar button, .mica-wb-sidebar [tabindex="0"]',
            )
            ?.focus(),
        );
    },
    'workbench.closeContainer': async () => {
      activeContainer = undefined;
      update();
    },
    'workbench.setMode': ({ mode }) => setMode(mode),
    'simulation.pause': () => controlSimulation('pause'),
    'simulation.resume': () => controlSimulation('resume'),
    'canvas.fit': async () => {
      canvas?.fit();
    },
    'canvas.zoom': async ({ factor }) => {
      if (!(factor > 0) || !Number.isFinite(factor))
        throw new Error('Zoom factor must be positive');
      canvas?.zoom(factor);
    },
    'canvas.setTool': async ({ tool: next }) => {
      if (!['select', 'wire', 'power', 'ground', 'label'].includes(next))
        throw new Error(`Unknown tool: ${String(next)}`);
      if (next !== 'select') assertEditable();
      tool = next;
      if (next === 'label') {
        const used = new Set(documentSession.getDocument().labels.map((label) => label.name));
        let index = 1;
        while (used.has(`NET${index}`)) index++;
        labelName = `NET${index}`;
      }
      placement = undefined;
      placementRotation = 0;
      update();
    },
    'device.place': ({ device }) => placeDevice(device),
    'device.add': async ({ device, placement }) => {
      assertEditable();
      const id = await documentSession.addDevice(device, placement);
      setSelection([{ kind: 'instance', id }]);
      return id;
    },
    'device.setProperty': async ({ instanceId, key, value }) => {
      assertEditable();
      await documentSession.setProperty(instanceId, key, value);
    },
    'device.removeProperty': async ({ instanceId, key }) => {
      assertEditable();
      await documentSession.removeProperty(instanceId, key);
    },
    'device.move': async ({ instanceId, position }) => {
      assertEditable();
      await documentSession.moveInstance(instanceId, position);
    },
    'device.rotate': async ({ instanceId, degrees }) => {
      assertEditable();
      await documentSession.rotateInstance(instanceId, degrees);
    },
    'selection.delete': async () => {
      assertEditable();
      await documentSession.remove(selection);
      setSelection([]);
    },
    'selection.rotate': async ({ degrees }) => {
      assertEditable();
      if (!Number.isFinite(degrees)) throw new Error('Rotation must be finite');
      if (placement !== undefined || tool === 'power' || tool === 'ground') {
        placementRotation = (((placementRotation + degrees) % 360) + 360) % 360;
        update();
        return;
      }
      await documentSession.transact((current) => rotateTargets(current, selection, degrees));
    },
    'wire.moveSegment': async ({ wireId, segment, delta }) => {
      assertEditable();
      await documentSession.transact((current) =>
        moveWireSegment(
          current,
          documentSession.getDevices().getLoadedDevices(),
          wireId,
          segment,
          delta,
        ),
      );
    },
    'text.move': async ({ target, offset }) => {
      assertEditable();
      await documentSession.transact((current) => setTextOffset(current, target, offset));
    },
    'reference.move': async ({ referenceId, position }) => {
      assertEditable();
      await documentSession.transact((current) =>
        moveReference(
          current,
          documentSession.getDevices().getLoadedDevices(),
          referenceId,
          position,
          () => crypto.randomUUID(),
        ),
      );
    },
    'label.move': async ({ labelId, position }) => {
      assertEditable();
      await documentSession.transact((current) =>
        moveLabel(current, documentSession.getDevices().getLoadedDevices(), labelId, position),
      );
    },
    'label.setName': async ({ labelId, name }) => {
      assertEditable();
      await documentSession.transact((current) => setLabelName(current, labelId, name));
    },
    'reference.setVoltage': async ({ referenceId, voltage }) => {
      assertEditable();
      await documentSession.transact((current) =>
        setReferenceVoltage(current, referenceId, voltage),
      );
    },
    'reference.setName': async ({ referenceId, name }) => {
      assertEditable();
      await documentSession.transact((current) =>
        setReferenceLabelName(current, referenceId, name),
      );
    },
    'reference.setRotation': async ({ referenceId, rotation }) => {
      assertEditable();
      await documentSession.transact((current) =>
        setReferenceRotation(current, referenceId, rotation),
      );
    },
    'wire.add': ({ from, to, bends }) => {
      assertEditable();
      return documentSession.addWire(from, to, bends);
    },
    'reference.add': ({ target, voltage, symbol }) => {
      assertEditable();
      return documentSession.addReference(target, voltage, symbol);
    },
    'label.add': ({ target, name }) => {
      assertEditable();
      return documentSession.addLabel(target, name);
    },
    'document.undo': () => documentSession.undo(),
    'document.redo': () => documentSession.redo(),
    'document.save': () => documentSession.save(),
    'view.open': ({ instanceId, viewId, location }) => openView(instanceId, viewId, location),
    'view.setLocation': ({ instanceId, viewId, location }) =>
      openView(instanceId, viewId, location),
    'view.close': async ({ instanceId, viewId }) => {
      const layout = viewLayout(instanceId);
      if (!layout.views.some((view) => view.viewId === viewId))
        throw new Error(`Unknown device view: ${viewId}`);
      htmlViews?.close(instanceId, viewId);
      await changeViewLayout(instanceId, {
        ...layout,
        views: layout.views.map((view) =>
          view.viewId === viewId && view.location === 'sidebar'
            ? { ...view, collapsed: true }
            : view,
        ),
      });
    },
    'view.setLayout': ({ instanceId, layout }) => changeViewLayout(instanceId, layout),
  };
  const workbench: IWorkbench = {
    contextKeys,
    onDidChangeContent: content.event,
    onDidChangeSelection: selectionChanged.event,
    onDidChangeState: stateChanged.event,
    onDidReportDiagnostic: diagnosticsChanged.event,
    onDidRequestOpenProject: openProject.event,
    getDocument: () => {
      assertReady();
      return documentSession.getDocument();
    },
    getState: () => {
      assertReady();
      return state;
    },
    getSelection: () => {
      assertReady();
      return selection;
    },
    getTheme: () => {
      assertReady();
      return theme;
    },
    setTheme(value) {
      assertReady();
      theme = validateTheme(value);
      update();
    },
    setSelection,
    setMode: (mode) => workbench.executeCommand('workbench.setMode', { mode }),
    save: () => workbench.executeCommand('document.save'),
    async executeCommand<K extends keyof IWorkbenchCommandMap>(
      id: K,
      ...args: WorkbenchCommandArgs<IWorkbenchCommandMap[K]>
    ): Promise<IWorkbenchCommandMap[K]['result']> {
      try {
        assertReady();
        const handler = handlers[id];
        if (handler === undefined) throw new Error(`Unknown workbench command: ${String(id)}`);
        return await handler(args[0] as IWorkbenchCommandMap[K]['params']);
      } catch (reason) {
        error(reason);
        throw reason;
      }
    },
    dispose() {
      if (disposal !== undefined) return disposal;
      disposed = true;
      abort.abort();
      disposal = (async () => {
        const errors: unknown[] = [];
        const release = async (action: () => void | Promise<void>) => {
          try {
            await action();
          } catch (reason) {
            errors.push(reason);
          }
        };
        await release(() => root.unmount());
        await release(async () => {
          await transition;
          await presentation;
          await releaseRuntime();
        });
        await release(() => documentSession.dispose());
        await release(() => htmlViews?.dispose());
        await release(() => disposables.dispose());
        clearOverlays();
        for (const image of images.values()) if (image instanceof ImageBitmap) image.close();
        images.clear();
        mount.remove();
        environment.remove();
        if (errors.length)
          throw new AggregateError(errors, 'Failed to release workbench resources');
      })();
      return disposal;
    },
  };
  const context: IWorkbenchExtensionContext = { workbench, contextKeys, signal: abort.signal };
  const builtins: IWorkbenchContributions = {
    containers: [
      { id: 'mica.instances', title: '器件列表', icon: 'list-tree', order: 100 },
      { id: 'mica.properties', title: '信息', icon: 'info', order: -1000 },
      { id: 'mica.problems', title: '问题', icon: 'warning', order: 300 },
    ],
    toolbar: (['select', 'wire', 'power', 'ground', 'label'] as const).map((value, index) => ({
      id: `mica.tool.${value}`,
      title: {
        select: '选择',
        wire: '接线',
        power: '电源',
        ground: '接地',
        label: '网标',
      }[value],
      icon: { select: 'cursor', wire: 'plug', power: 'zap', ground: 'circuit-board', label: 'tag' }[
        value
      ],
      group: 'edit',
      order: index * 10,
      when: "workbench.mode == 'edit'",
      enablement: value === 'select' ? '!workbench.busy' : 'document.editable && !workbench.busy',
      execute: (context) => context.workbench.executeCommand('canvas.setTool', { tool: value }),
    })),
  };
  try {
    registry = new ContributionRegistry(contextKeys, builtins, options.contributions);
    htmlViews = createHtmlViewHost({
      viewBaseUrlTemplate: options.viewBaseUrlTemplate,
      container: options.container,
      registry: options.deviceProvider,
      describe(instanceId) {
        if (mode !== 'run' || busy || runtime === undefined) return undefined;
        const presentation = runtime.display.instances.find(
          (item) => item.instanceId === instanceId,
        );
        const manifest =
          presentation === undefined
            ? undefined
            : documentSession.getDevices().getLoaded(presentation.device)?.manifest;
        if (presentation === undefined || manifest === undefined) return undefined;
        return {
          device: presentation.device,
          lock: presentation.lock,
          props: presentation.props,
          methods: presentation.methods,
          events: presentation.events,
          hasModel: manifest.model !== undefined,
          views: manifest.view ?? {},
        };
      },
      model(instanceId) {
        const instance = documentSession
          .getDocument()
          .instances.find((item) => item.id === instanceId);
        if (
          instance === undefined ||
          documentSession.getDevices().getLoaded(instance.device)?.manifest.model === undefined
        )
          return undefined;
        if (runtime === undefined) throw new Error('The view model session is disconnected');
        return runtime.getModel(instanceId);
      },
      onDiagnostic: (failure) =>
        report({
          code: failure.code,
          message: `${failure.title}: ${failure.message}`,
          instanceId: failure.instanceId,
          severity: 'error',
        }),
    });
  } catch (reason) {
    await workbench.dispose();
    throw reason;
  }
  disposables.add(htmlViews.onDidChange(update));
  const ui: IWorkbenchUI = {
    workbench,
    options,
    context,
    get theme() {
      return theme;
    },
    htmlViews,
    viewLayout,
    changeViewLayout,
    contributions: registry,
    onDidUpdate: uiChanged.event,
    get devices() {
      return documentSession.getDevices().getLoadedDevices();
    },
    images,
    overlays,
    diagnostics,
    get placement() {
      return placement;
    },
    get placementRotation() {
      return placementRotation;
    },
    get version() {
      return version;
    },
    setCanvas: (value) => {
      canvas = value;
    },
    report,
    error,
    input: (instanceId, event: IViewInput) => {
      try {
        runtime?.display.input(instanceId, event);
      } catch (reason) {
        error(reason);
      }
    },
    get labelName() {
      return labelName;
    },
    setLabelName: (name) => {
      labelName = name;
      update();
    },
    connect: async (from, to, bends) => {
      assertEditable();
      await documentSession.transact((current) => {
        const devices = documentSession.getDevices().getLoadedDevices();
        const first = materializeAnchor(routeDocumentWires(current, devices), from, devices, () =>
          crypto.randomUUID(),
        );
        const last = materializeAnchor(first.document, to, devices, () => crypto.randomUUID());
        return addWire(last.document, first.endpoint, last.endpoint, bends, () =>
          crypto.randomUUID(),
        ).document;
      });
    },
    endpoint: async (target: Endpoint | Point2D) => {
      assertEditable();
      const activeTool = tool;
      const rotation = placementRotation;
      const name = labelName.trim();
      if (activeTool !== 'power' && activeTool !== 'ground' && activeTool !== 'label')
        throw new Error('未选择端子或网标放置工具');
      if (activeTool === 'label' && name === '') throw new Error('网标名称不能为空');
      await documentSession.transact((current) => {
        const anchor = materializeAnchor(
          routeDocumentWires(current, documentSession.getDevices().getLoadedDevices()),
          target,
          documentSession.getDevices().getLoadedDevices(),
          () => crypto.randomUUID(),
        );
        return activeTool === 'label'
          ? addLabel(anchor.document, anchor.endpoint, name, {}, () => crypto.randomUUID()).document
          : addPlacedReference(anchor.document, anchor.endpoint, activeTool, rotation, () =>
              crypto.randomUUID(),
            ).document;
      });
      if (tool === activeTool) {
        tool = 'select';
        update();
      }
    },
    cancel: () => {
      placement = undefined;
      placementRotation = 0;
      tool = 'select';
      update();
    },
    focus: (value) => keys.focus.set(value),
    viewport: () => runtime?.display.invalidate(),
    reveal: (id) => {
      setSelection([{ kind: 'instance', id }]);
      canvas?.reveal(id);
    },
    validateResource: async (instanceId, key, value, signal) => {
      const instance = documentSession
        .getDocument()
        .instances.find((value) => value.id === instanceId);
      const descriptor =
        instance === undefined
          ? undefined
          : documentSession.getDevices().getLoaded(instance.device)?.manifest.properties?.[key];
      if (
        descriptor === undefined ||
        !['image', 'binary', 'firmware', 'program'].includes(descriptor.type)
      )
        throw new Error('Unknown resource property');
      if (instance === undefined) throw new Error('Unknown resource instance');
      const device = documentSession.getDevices().requireLoaded(instance.device);
      const verified = await openDevicePackage(options.deviceProvider, device.lock);
      signal.throwIfAborted();
      const resolved = await resolveInstanceProperties({
        instanceId,
        package: verified,
        descriptors: { [key]: descriptor },
        overrides: { [key]: value },
        irProperties: new Map(),
        pointer: ['properties'],
        signal,
        ...(options.programs === undefined ? {} : { programs: options.programs }),
        resolveResource: (request) => {
          if (request.reference.mode !== 'asset' || options.assetProvider === undefined)
            throw new Error('No asset provider is configured');
          return options.assetProvider.read(request.reference.assetId, signal);
        },
      });
      signal.throwIfAborted();
      const resource = resolved.props[key];
      if (
        resource &&
        typeof resource === 'object' &&
        'slice' in resource &&
        typeof resource.slice === 'function'
      ) {
        const bytes: unknown = resource.slice();
        if (!(bytes instanceof Uint8Array)) throw new Error('Resource did not resolve to bytes');
        if (descriptor.type === 'image') {
          const sourceName =
            value !== null && typeof value === 'object'
              ? value.mode === 'package'
                ? value.src
                : (value.name ?? '')
              : '';
          const bitmap = await decodeResourceImage(bytes, sourceName);
          try {
            if (
              descriptor.maxPixels !== undefined &&
              bitmap.width * bitmap.height > descriptor.maxPixels
            )
              throw new Error('Image exceeds the property pixel limit');
          } finally {
            if (bitmap instanceof ImageBitmap) bitmap.close();
          }
        }
        signal.throwIfAborted();
        return bytes;
      }
      return undefined;
    },
    commitResource: async (instanceId, key, expected, value, signal) => {
      await documentSession.transact((current) => {
        signal.throwIfAborted();
        assertEditable();
        const instance = current.instances.find((entry) => entry.id === instanceId);
        if (
          instance === undefined ||
          JSON.stringify(instance.properties?.[key]) !== JSON.stringify(expected)
        )
          throw new Error('resource/target-changed: 属性已改变，请重新选择资源');
        return setInstanceProperty(current, instanceId, key, value);
      });
    },
    openProject: (projectId) => openProject.fire({ projectId }),
    programPackagePaths: (deviceId) =>
      Object.keys(documentSession.getDevices().getLoaded(deviceId)?.files.files ?? {}),
    programSnapshot: (instanceId) => {
      const prepared = runtimeDocument?.instances.find((instance) => instance.id === instanceId);
      const current = documentSession
        .getDocument()
        .instances.find((instance) => instance.id === instanceId);
      if (
        !prepared ||
        !current ||
        prepared.device !== current.device ||
        JSON.stringify(prepared.properties) !== JSON.stringify(current.properties)
      )
        return undefined;
      return runtime?.display.instances.find((instance) => instance.instanceId === instanceId)
        ?.props;
    },
  };
  disposables.add(
    documentSession.onDidChangeContent((value) => {
      const ids = new Set(
        [
          ...value.instances,
          ...value.wires,
          ...value.nodes,
          ...value.labels,
          ...value.references,
        ].map((item) => item.id),
      );
      if (selection.some((target) => !ids.has(target.id))) {
        selection = Object.freeze(selection.filter((target) => ids.has(target.id)));
        selectionChanged.fire(selection);
      }
      content.fire(value);
      for (const handle of htmlViews?.views ?? []) {
        if (!value.instances.some((instance) => instance.id === handle.instanceId)) {
          handle.close();
          continue;
        }
        const target = viewLayout(handle.instanceId).views.find(
          (view) => view.viewId === handle.viewId,
        );
        if (target === undefined) handle.close();
        else {
          handle.setLocation(target.location);
          handle.setVisible(target.location === 'floating' || !target.collapsed);
        }
      }
      refreshLayoutDiagnostics();
      update();
      refreshPresentation();
    }),
  );
  disposables.add(
    documentSession.onDidChangeState(() => {
      update();
      if (mode === 'run' && !documentSession.getAccess().run.allowed)
        void setMode('edit').catch(error);
    }),
  );
  disposables.add(documentSession.onDidError(error));
  disposables.add(
    contextKeys.onDidChange((event) => {
      if (registry.affected(new Set(event.names))) {
        version++;
        uiChanged.fire();
      }
    }),
  );
  options.container.append(mount, environment);
  try {
    const audio = options.audio?.context;
    if (audio !== undefined) {
      let resuming = false;
      const unlockAudio = (event: Event) => {
        if (!event.isTrusted || audio.state !== 'suspended' || resuming) return;
        // Touch and pen activation is available on release rather than pointerdown.
        if (event.type === 'pointerdown' && 'pointerType' in event && event.pointerType !== 'mouse')
          return;
        resuming = true;
        void audio
          .resume()
          .catch((reason: unknown) => {
            report({ code: 'audio/failed', message: errorMessage(reason), severity: 'error' });
          })
          .finally(() => {
            resuming = false;
          });
      };
      for (const type of ['pointerdown', 'pointerup', 'keydown']) {
        options.container.ownerDocument.addEventListener(type, unlockAudio, {
          capture: true,
          signal: abort.signal,
        });
      }
    }
    await loadImages();
    refreshLayoutDiagnostics();
    update();
    flushSync(() => root.render(<WorkbenchPart ui={ui} />));
    const preparationError = documentSession.getPreparationError();
    if (preparationError !== undefined) error(preparationError);
    refreshPresentation();
    return workbench;
  } catch (reason) {
    await workbench.dispose();
    throw reason;
  }
}
