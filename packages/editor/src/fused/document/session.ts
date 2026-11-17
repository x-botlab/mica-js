/**
 * Document and editing session of the fused workbench (RFC 0024).
 *
 * The session owns the immutable document, the unified undo history and the saved marker. It is the
 * single writer: every operation is serialized, re-checks the access policy right before the commit,
 * verifies the candidate against the locked packages and only then publishes one content event.
 *
 * Permission and run locking are enforced centrally for every write, including view layouts:
 *
 * - `edit` denied: no mutation at all; the document stays browsable and unsaved content is kept.
 * - running: properties, connections and other content stay read-only, view layouts stay editable,
 *   and undo/redo only walks layout transactions at the top of the history.
 */
import { DisposableStore, Emitter } from '@mica-js/core/lifecycle';
import type { Event } from '@mica-js/core/lifecycle';
import { parseFusedDocument } from '@mica-js/document/fused';
import type {
  DeviceLock,
  Endpoint,
  FusedDocument,
  FusedTopology,
  InstanceViewLayout,
  Placement2D,
  Point2D,
  PropertyValue,
} from '@mica-js/document/fused';
import type {
  AccessDecision,
  IDeviceProvider,
  IDocumentAccess,
  IWorkbenchAccessProvider,
} from '../providers';
import { DeviceCache } from '../devices';
import type { IDeviceCache, IPreparedDevice } from '../devices';
import {
  addInstance,
  addLabel,
  addNode,
  addReference,
  addWire,
  moveInstances,
  removeInstanceProperty,
  removeTargets,
  renameDesignator,
  rotateInstances,
  setInstancePosition,
  setInstanceProperty,
  setViewLayout as replaceViewLayout,
} from './edits';
import type { IFusedDocumentTarget, IFusedLabelOptions, IFusedReferenceOptions } from './edits';
import { copyTargets, pasteClipboard } from './copy';
import { routeWireBends } from '../wiring';
import type { IFusedClipboard } from './copy';
import { verifyFusedDocument } from './verify';
import type { IVerifiedFusedDocument } from './verify';
import { accessDenied, FusedSessionError, toSessionError } from './errors';

const DEFAULT_HISTORY_LIMIT = 200;

type DeniedDecision = Extract<AccessDecision, { readonly allowed: false }>;
type WriteMode = 'content' | 'layout';

export interface IFusedDocumentSessionOptions {
  readonly document: FusedDocument;
  readonly saveDocument?: (document: FusedDocument) => Promise<void>;
  /** Locked package registry; the session owns its verified cache. */
  readonly devices: IDeviceProvider;
  readonly access: IWorkbenchAccessProvider;
  /** Maximum number of undo steps kept; defaults to 200. */
  readonly historyLimit?: number;
  /** Element id factory; defaults to `crypto.randomUUID`. */
  readonly createId?: () => string;
}

export interface IFusedDocumentState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly dirty: boolean;
  /** No mutation of any kind is allowed: the access policy denies editing this document. */
  readonly readOnly: boolean;
  /** A run is in progress; content and topology are read-only while layouts stay editable. */
  readonly running: boolean;
  readonly canEditContent: boolean;
  readonly canEditLayout: boolean;
  readonly access: IDocumentAccess;
}

export interface IFusedTransactionOptions {
  /** Declares a view-layout-only change: allowed while running, and rejected if it alters content. */
  readonly layoutOnly?: boolean;
}

interface IHistoryEntry {
  readonly before: FusedDocument;
  readonly after: FusedDocument;
  readonly contentChanged: boolean;
  readonly beforeTopology: FusedTopology | undefined;
  readonly afterTopology: FusedTopology;
  readonly beforeDevices: ReadonlyMap<string, IPreparedDevice>;
  readonly afterDevices: ReadonlyMap<string, IPreparedDevice>;
}

/**
 * One open fused document with its editing history.
 *
 * Create it with {@link FusedDocumentSession.open}; every method below documents whether it needs
 * `edit` permission and how it behaves while a run is active.
 */
export class FusedDocumentSession {
  readonly #saveDocument: ((document: FusedDocument) => Promise<void>) | undefined;
  readonly #access: IWorkbenchAccessProvider;
  readonly #packages: DeviceCache;
  readonly #createId: () => string;
  readonly #historyLimit: number;
  readonly #subscriptions = new DisposableStore();
  readonly #content = new Emitter<FusedDocument>();
  readonly #state = new Emitter<IFusedDocumentState>();
  readonly #errors = new Emitter<FusedSessionError>();
  readonly #keys = new WeakMap<FusedDocument, string>();
  readonly #contentKeys = new WeakMap<FusedDocument, string>();
  #document: FusedDocument;
  #savedKey: string;
  #past: IHistoryEntry[] = [];
  #future: IHistoryEntry[] = [];
  #decisions: IDocumentAccess;
  #prepared: ReadonlyMap<string, IPreparedDevice> = new Map();
  #topology: FusedTopology | undefined;
  #preparationError: FusedSessionError | undefined;
  #running = false;
  #queue: Promise<void> = Promise.resolve();
  #pendingAccess: Promise<void> | undefined;
  #evaluationRevision = 0;
  #appliedRevision = 0;
  #disposed = false;
  #lastStateSignature = '';

  private constructor(
    options: IFusedDocumentSessionOptions,
    document: FusedDocument,
    decisions: IDocumentAccess,
  ) {
    this.#saveDocument = options.saveDocument;
    this.#access = options.access;
    this.#packages = new DeviceCache(options.devices);
    this.#createId = options.createId ?? (() => globalThis.crypto.randomUUID());
    this.#historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.#document = document;
    this.#savedKey = canonicalJson(document);
    this.#decisions = decisions;
  }

  /**
   * Reads and parses `<uri>` and opens a session on it.
   *
   * A document whose packages or connection graph cannot be verified still opens for browsing; the
   * failure is reported by {@link getPreparationError} and every content edit then fails closed.
   *
   * @throws {FusedSessionError} when the supplied document violates RFC 0024 or the access policy
   * cannot be evaluated.
   */
  static async open(options: IFusedDocumentSessionOptions): Promise<FusedDocumentSession> {
    let document: FusedDocument;
    try {
      document = parseFusedDocument(options.document);
    } catch (cause) {
      throw toSessionError(cause, 'edit/invalid-document');
    }
    const decisions = await evaluateDecisions(options.access, document);
    const session = new FusedDocumentSession(options, document, decisions);
    await session.#start();
    session.#subscriptions.add(
      options.access.onDidChange(() => {
        session.#refreshAccessInBackground();
      }),
    );
    return session;
  }

  /** Fires once per committed change, undo and redo; rejected operations never fire it. */
  readonly onDidChangeContent: Event<FusedDocument> = this.#content.event;
  /** Fires whenever undo/redo, dirty, read-only or running change. */
  readonly onDidChangeState: Event<IFusedDocumentState> = this.#state.event;
  /** Fires for every rejected operation and access-policy failure with its code and problems. */
  readonly onDidError: Event<FusedSessionError> = this.#errors.event;

  /** Current immutable snapshot; the same reference until the next commit. */
  getDocument(): FusedDocument {
    this.#assertAlive();
    return this.#document;
  }

  getState(): IFusedDocumentState {
    this.#assertAlive();
    const readOnly = !this.#decisions.edit.allowed;
    const top = this.#past.at(-1);
    const next = this.#future.at(-1);
    return {
      canUndo: top !== undefined && (!this.#running || !top.contentChanged),
      canRedo: next !== undefined && (!this.#running || !next.contentChanged),
      dirty: this.#documentKey(this.#document) !== this.#savedKey,
      readOnly,
      running: this.#running,
      canEditContent: !readOnly && !this.#running,
      canEditLayout: !readOnly,
      access: this.#decisions,
    };
  }

  /** Decisions of the last evaluation; `run` is independent of `edit`. */
  getAccess(): IDocumentAccess {
    this.#assertAlive();
    return this.#decisions;
  }

  isRunning(): boolean {
    return this.#running;
  }

  /** Verified package cache shared with the canvas renderer; the session disposes it. */
  getDevices(): IDeviceCache {
    return this.#packages;
  }

  /** Nets of the last verified state, or `undefined` when the document never verified. */
  getTopology(): FusedTopology | undefined {
    this.#assertAlive();
    return this.#topology;
  }

  /** Why the document could not be verified on open; cleared by the next verified commit. */
  getPreparationError(): FusedSessionError | undefined {
    return this.#preparationError;
  }

  /** Manifests, geometry and verified files of every device the document uses. */
  getPreparedDevices(): Promise<ReadonlyMap<string, IPreparedDevice>> {
    return this.#enqueue(async () => {
      const prepared = await this.#packages.prepareDocument(this.#document);
      this.#prepared = sameDevices(this.#prepared, prepared) ? this.#prepared : prepared;
      return this.#prepared;
    });
  }

  /** Re-evaluates the access policy, for example after an external sign-in change. */
  refreshAccess(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#settleAccess();
      await this.#evaluate();
      this.#publishState();
    });
  }

  /**
   * Locks or unlocks content editing for a run.
   *
   * Enabling needs the independent `run` permission; disabling always succeeds. The flag never
   * changes the document, history or dirty marker.
   */
  setRunning(running: boolean): Promise<void> {
    return this.#enqueue(async () => {
      await this.#settleAccess();
      const decisions = await this.#evaluate();
      if (running) {
        const decision = decisions.run;
        if (!decision.allowed) {
          throw accessDenied('access/run-denied', decision);
        }
      }
      if (running === this.#running) {
        this.#publishState();
        return;
      }
      this.#running = running;
      this.#publishState();
    });
  }

  /**
   * Applies one arbitrary, already built document as one transaction.
   *
   * This is the generic write gate: it checks the access policy like every named operation, so a
   * caller cannot bypass read-only or run locking through it. Use `layoutOnly` for view layouts.
   *
   * @throws {FusedSessionError} for denied permission, a running lock, or an invalid candidate.
   */
  transact(
    update: (document: FusedDocument) => FusedDocument | Promise<FusedDocument>,
    options: IFusedTransactionOptions = {},
  ): Promise<FusedDocument> {
    return this.#write(options.layoutOnly === true ? 'layout' : 'content', async (current) => {
      const candidate = await update(current);
      if (candidate === null || typeof candidate !== 'object') {
        throw new FusedSessionError(
          'edit/invalid-request',
          'A transaction must return the next document.',
        );
      }
      return { document: candidate, result: candidate };
    });
  }

  /**
   * Places one device, locking its release and allocating the smallest free designator.
   *
   * Needs `edit` permission, a verified package with geometry and body image, and a policy that
   * allows adding this device. An existing lock of another release is rejected, never replaced.
   *
   * @returns the new instance id.
   */
  addDevice(lock: DeviceLock, placement: Placement2D): Promise<string> {
    return this.#write('content', async (current) => {
      const device = await this.#packages.get(lock);
      this.#requireUnchangedLock(current, device.lock);
      const added = addInstance(current, device, placement, this.#createId);
      return { document: added.document, result: added.instanceId };
    });
  }

  /** Removes the targets as one transaction; instances cascade to their wires, labels and references. */
  remove(targets: readonly IFusedDocumentTarget[]): Promise<FusedDocument> {
    return this.#edit((current) => removeTargets(current, targets));
  }

  /** Moves one instance so its origin lands on `position`. */
  moveInstance(instanceId: string, position: Point2D): Promise<FusedDocument> {
    return this.#edit((current) => setInstancePosition(current, instanceId, position));
  }

  /** Offsets instances by a scene-space delta, for a finished drag. */
  moveInstances(instanceIds: readonly string[], delta: Point2D): Promise<FusedDocument> {
    return this.#edit((current) => moveInstances(current, instanceIds, delta));
  }

  /** Rotates instances clockwise by `degrees`. */
  rotateInstances(instanceIds: readonly string[], degrees: number): Promise<FusedDocument> {
    return this.#edit((current) => rotateInstances(current, instanceIds, degrees));
  }

  /** Rotates one instance clockwise by `degrees`; the canvas sends the drag delta. */
  rotateInstance(instanceId: string, degrees: number): Promise<FusedDocument> {
    return this.#edit((current) => rotateInstances(current, [instanceId], degrees));
  }

  /**
   * Renames one instance designator.
   *
   * @throws {FusedSessionError} (`edit/duplicate-designator`) when another instance owns the name.
   */
  renameDesignator(instanceId: string, designator: string): Promise<FusedDocument> {
    return this.#edit((current) => renameDesignator(current, instanceId, designator));
  }

  /** Stores one property override on an instance. */
  setProperty(instanceId: string, key: string, value: PropertyValue): Promise<FusedDocument> {
    return this.#edit((current) => setInstanceProperty(current, instanceId, key, value));
  }

  /** Drops one property override; an unknown key is a no-op. */
  removeProperty(instanceId: string, key: string): Promise<FusedDocument> {
    return this.#edit((current) => removeInstanceProperty(current, instanceId, key));
  }

  /** Adds a free or junction node; `id` is the new node id. */
  addNode(point: Point2D, kind: 'junction' | 'free'): Promise<string> {
    return this.#write('content', async (current) => {
      const added = addNode(current, point, kind, this.#createId);
      return { document: added.document, result: added.nodeId };
    });
  }

  /**
   * Connects two endpoints; `bends` are the intermediate waypoints only.
   *
   * The persisted bends are routed against the loaded pin geometry, so the new wire has no
   * diagonal leg even when the two anchors are not aligned.
   */
  addWire(from: Endpoint, to: Endpoint, bends: readonly Point2D[] = []): Promise<string> {
    return this.#write('content', async (current) => {
      const devices = await this.#packages.prepareDocument(current);
      const routed = routeWireBends(current, devices, from, to, bends);
      const added = addWire(current, from, to, routed, this.#createId);
      return { document: added.document, result: added.wireId };
    });
  }

  /** Attaches an ideal voltage reference, optionally drawn as the power or ground symbol. */
  addReference(
    target: Endpoint,
    voltage: number,
    symbol?: 'power' | 'ground',
    options: IFusedReferenceOptions = {},
  ): Promise<string> {
    return this.#write('content', async (current) => {
      const added = addReference(current, target, voltage, symbol, options, this.#createId);
      return { document: added.document, result: added.referenceId };
    });
  }

  /** Declares a net name on one endpoint. */
  addLabel(target: Endpoint, name: string, options: IFusedLabelOptions = {}): Promise<string> {
    return this.#write('content', async (current) => {
      const added = addLabel(current, target, name, options, this.#createId);
      return { document: added.document, result: added.labelId };
    });
  }

  /**
   * Stores the per-instance view layout, or restores the defaults with `undefined`.
   *
   * This is a layout transaction: it is allowed while running and rejected if it changes content.
   */
  setViewLayout(
    instanceId: string,
    layout: InstanceViewLayout | undefined,
  ): Promise<FusedDocument> {
    return this.#write('layout', async (current) => {
      const next = replaceViewLayout(current, instanceId, layout);
      return { document: next, result: next };
    });
  }

  /** Extracts the selected subgraph; a pure read that records no history. */
  copy(targets: readonly IFusedDocumentTarget[]): IFusedClipboard | undefined {
    this.#assertAlive();
    return copyTargets(this.#document, targets);
  }

  /**
   * Inserts a copied subgraph as one transaction.
   *
   * Copied devices must be locked by the clipboard, verified through their package and allowed by
   * the device-addition policy; connected edges outside the copy are not reproduced.
   */
  paste(clipboard: IFusedClipboard, offset: Point2D = { x: 0, y: 0 }): Promise<FusedDocument> {
    return this.#write('content', async (current) => {
      if (clipboard === null || typeof clipboard !== 'object') {
        throw new FusedSessionError('edit/invalid-request', 'The clipboard payload is missing.');
      }
      if (clipboard.instances.length === 0) {
        throw new FusedSessionError('edit/invalid-request', 'The clipboard holds no instances.');
      }
      const prepared = new Map<string, IPreparedDevice>();
      for (const deviceId of new Set(clipboard.instances.map((instance) => instance.device))) {
        const dependency = clipboard.dependencies[deviceId];
        if (dependency === undefined) {
          throw new FusedSessionError(
            'edit/invalid-request',
            `The clipboard does not lock "${deviceId}".`,
          );
        }
        const device = await this.#packages.get({
          id: deviceId,
          version: dependency.version,
          integrity: dependency.integrity,
        });
        this.#requireUnchangedLock(current, device.lock);
        prepared.set(deviceId, device);
      }
      const next = pasteClipboard(current, clipboard, offset, prepared, this.#createId);
      return { document: next, result: next };
    });
  }

  /**
   * Rewrites the `.sch` file with the current content and marks it saved.
   *
   * Needs `edit` permission. Edits made while the write is pending run afterwards and keep the
   * document dirty; the saved marker is restored by undoing back to the written snapshot.
   */
  save(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#settleAccess();
      this.#requireEdit('layout');
      const document = this.#document;
      await this.#authorize('layout', document, document);
      if (this.#saveDocument === undefined)
        throw new FusedSessionError(
          'save/unavailable',
          'The host does not provide document saving.',
        );
      try {
        await this.#saveDocument(document);
      } catch (cause) {
        throw new FusedSessionError('save/failed', 'Cannot save the document.', { cause });
      }
      this.#assertAlive();
      this.#savedKey = this.#documentKey(document);
      this.#publishState();
    });
  }

  /** Undoes the top step; while running only a layout step at the top of the history is undone. */
  undo(): Promise<void> {
    return this.#enqueue(async () => {
      const entry = this.#past.at(-1);
      if (entry === undefined) {
        return;
      }
      const mode: WriteMode = entry.contentChanged ? 'content' : 'layout';
      await this.#settleAccess();
      this.#requireHistoryStep(entry);
      await this.#authorize(mode, entry.before, this.#document);
      this.#past.pop();
      this.#future.push(entry);
      this.#restore(entry.before, entry.beforeDevices, entry.beforeTopology);
    });
  }

  /** Redoes the top undone step with the same run-locking rules as {@link undo}. */
  redo(): Promise<void> {
    return this.#enqueue(async () => {
      const entry = this.#future.at(-1);
      if (entry === undefined) {
        return;
      }
      const mode: WriteMode = entry.contentChanged ? 'content' : 'layout';
      await this.#settleAccess();
      this.#requireHistoryStep(entry);
      await this.#authorize(mode, entry.after, this.#document);
      this.#future.pop();
      this.#past.push(entry);
      this.#restore(entry.after, entry.afterDevices, entry.afterTopology);
    });
  }

  /** Releases the access subscription, the package cache and every event; content is untouched. */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#subscriptions.dispose();
    this.#packages.dispose();
    this.#content.dispose();
    this.#state.dispose();
    this.#errors.dispose();
  }

  async #start(): Promise<void> {
    try {
      const verified = await verifyFusedDocument(this.#document, this.#packages);
      this.#document = verified.document;
      this.#prepared = verified.devices;
      this.#topology = verified.topology;
    } catch (cause) {
      this.#preparationError = toSessionError(cause, 'device/unavailable');
    }
    this.#savedKey = this.#documentKey(this.#document);
    this.#lastStateSignature = this.#stateSignature();
  }

  #edit(update: (current: FusedDocument) => FusedDocument): Promise<FusedDocument> {
    return this.#write('content', async (current) => {
      const next = update(current);
      return { document: next, result: next };
    });
  }

  async #write<R>(
    mode: WriteMode,
    build: (
      current: FusedDocument,
    ) => Promise<{ readonly document: FusedDocument; readonly result: R }>,
  ): Promise<R> {
    return this.#enqueue(async () => {
      // A provider change that is still being evaluated blocks the write before any work is done.
      await this.#settleAccess();
      this.#requireEdit(mode);
      const current = this.#document;
      const built = await build(current);
      const verified = await verifyFusedDocument(built.document, this.#packages, {
        routeWires: mode === 'content',
        previous: current,
      });
      await this.#authorize(mode, verified.document, current);
      this.#commit(verified, current, mode);
      return built.result;
    });
  }

  #commit(verified: IVerifiedFusedDocument, current: FusedDocument, mode: WriteMode): void {
    const next = verified.document;
    const contentChanged = this.#contentKey(next) !== this.#contentKey(current);
    if (mode === 'layout' && contentChanged) {
      throw new FusedSessionError(
        'edit/layout-mismatch',
        'A layout transaction must not change devices, connections, labels or references.',
      );
    }
    if (this.#documentKey(next) === this.#documentKey(current)) {
      return;
    }
    this.#past.push({
      before: current,
      after: next,
      contentChanged,
      beforeTopology: this.#topology,
      afterTopology: verified.topology,
      beforeDevices: this.#prepared,
      afterDevices: verified.devices,
    });
    if (this.#past.length > this.#historyLimit) {
      this.#past.shift();
    }
    this.#future = [];
    this.#topology = verified.topology;
    this.#prepared = sameDevices(this.#prepared, verified.devices)
      ? this.#prepared
      : verified.devices;
    this.#preparationError = undefined;
    this.#document = next;
    this.#content.fire(next);
    this.#publishState();
  }

  #restore(
    document: FusedDocument,
    devices: ReadonlyMap<string, IPreparedDevice>,
    topology: FusedTopology | undefined,
  ): void {
    this.#document = document;
    this.#prepared = devices;
    this.#topology = topology;
    this.#content.fire(document);
    this.#publishState();
  }

  #requireEdit(mode: WriteMode): void {
    this.#requireDecision(mode, this.#decisions);
  }

  #requireDecision(mode: WriteMode, decisions: IDocumentAccess): void {
    this.#assertAlive();
    const edit = decisions.edit;
    if (!edit.allowed) {
      throw accessDenied('access/edit-denied', edit);
    }
    if (mode === 'content' && this.#running) {
      throw new FusedSessionError(
        'access/running',
        'Devices and connections are read-only while the circuit runs; stop the run first.',
      );
    }
  }

  /**
   * Authorizes one mutation against the candidate document.
   *
   * Waits for provider-triggered re-checks, evaluates the policy for the candidate itself, then
   * verifies that every instance and release the candidate introduces may be added. Both checks
   * repeat when the policy changes while they run; nothing is committed before this returns.
   */
  async #authorize(mode: WriteMode, target: FusedDocument, current: FusedDocument): Promise<void> {
    this.#assertAlive();
    for (let pass = 0; pass < 4; pass += 1) {
      await this.#settleAccess();
      const decisions = await this.#evaluate(target);
      if (this.#pendingAccess !== undefined) {
        continue;
      }
      this.#requireDecision(mode, decisions);
      await this.#requireAdditions(current, target);
      if (this.#pendingAccess !== undefined) {
        continue;
      }
      return;
    }
    throw new FusedSessionError(
      'access/check-failed',
      'The access policy kept changing while the operation was authorized.',
    );
  }

  /**
   * Checks the device-addition policy for every instance and release the target introduces.
   *
   * Generic transactions, undo and redo pass through here as well, so no entry point can introduce
   * a locked release that `canAddDevice` forbids.
   */
  async #requireAdditions(current: FusedDocument, target: FusedDocument): Promise<void> {
    const existingInstances = new Set(current.instances.map((instance) => instance.id));
    const locks = new Map<string, DeviceLock>();
    for (const instance of target.instances) {
      if (existingInstances.has(instance.id)) {
        continue;
      }
      const dependency = target.dependencies[instance.device];
      if (dependency === undefined) {
        continue;
      }
      locks.set(lockKey(instance.device, dependency), {
        id: instance.device,
        version: dependency.version,
        integrity: dependency.integrity,
      });
    }
    for (const [deviceId, dependency] of Object.entries(target.dependencies)) {
      if (current.dependencies[deviceId] !== undefined) {
        continue;
      }
      locks.set(lockKey(deviceId, dependency), {
        id: deviceId,
        version: dependency.version,
        integrity: dependency.integrity,
      });
    }
    for (const lock of locks.values()) {
      await this.#requireCanAddDevice(target, lock);
    }
  }

  #requireHistoryStep(entry: IHistoryEntry): void {
    this.#requireEdit(entry.contentChanged ? 'content' : 'layout');
  }

  #requireUnchangedLock(document: FusedDocument, lock: DeviceLock): void {
    const existing = document.dependencies[lock.id];
    if (
      existing !== undefined &&
      (existing.version !== lock.version || existing.integrity !== lock.integrity)
    ) {
      throw new FusedSessionError(
        'document/locked-conflict',
        `"${lock.id}" is already locked to ${existing.version}; the document here does not replace an existing lock.`,
      );
    }
  }

  async #requireCanAddDevice(document: FusedDocument, device: DeviceLock): Promise<void> {
    let decision: AccessDecision;
    try {
      decision = await this.#access.canAddDevice({
        document,
        device,
      });
    } catch (cause) {
      throw new FusedSessionError(
        'access/check-failed',
        'The access policy cannot decide whether this device may be added.',
        { cause },
      );
    }
    const normalized = normalizeDecision(decision, 'device addition');
    if (!normalized.allowed) {
      throw accessDenied('access/add-denied', normalized);
    }
  }

  /**
   * Evaluates the access policy for `target`, the document a decision applies to.
   *
   * The returned decisions are the ones the caller must authorize with; the cached state only
   * follows the newest evaluation, so an older, slower answer cannot override a newer one.
   */
  async #evaluate(target: FusedDocument = this.#document): Promise<IDocumentAccess> {
    this.#assertAlive();
    const revision = (this.#evaluationRevision += 1);
    let decisions: IDocumentAccess;
    try {
      decisions = await evaluateDecisions(this.#access, target);
    } catch (cause) {
      if (revision > this.#appliedRevision) {
        this.#appliedRevision = revision;
        // Fail closed: a policy that cannot decide grants nothing until the next successful refresh.
        const message = 'The access policy could not evaluate this document.';
        this.#decisions = {
          edit: denied('access/check-failed', message),
          run: denied('access/check-failed', message),
        };
        this.#publishState();
      }
      throw cause;
    }
    if (revision > this.#appliedRevision) {
      this.#appliedRevision = revision;
      this.#decisions = decisions;
    }
    return decisions;
  }

  /**
   * Starts the re-check a provider change demands, outside the write queue.
   *
   * Writes wait for it through {@link #settleAccess}; its failure is reported and already left in
   * the fail-closed decisions.
   */
  #refreshAccessInBackground(): void {
    if (this.#disposed) {
      return;
    }
    const pending = this.#evaluate().then(() => {
      this.#publishState();
    });
    const tracked = pending.finally(() => {
      if (this.#pendingAccess === tracked) {
        this.#pendingAccess = undefined;
      }
    });
    this.#pendingAccess = tracked;
    void tracked.catch((cause: unknown) => {
      const error = toSessionError(cause, 'access/check-failed');
      if (!this.#disposed && error.code !== 'session/disposed') {
        this.#errors.fire(error);
      }
    });
  }

  /** Waits until no provider-triggered re-check is in flight. */
  async #settleAccess(): Promise<void> {
    for (let pass = 0; pass < 8; pass += 1) {
      const pending = this.#pendingAccess;
      if (pending === undefined) {
        return;
      }
      try {
        await pending;
      } catch {
        // Reported by the refresh; the decisions are already fail-closed.
      }
      if (this.#pendingAccess === pending) {
        this.#pendingAccess = undefined;
        return;
      }
    }
  }

  #publishState(): void {
    if (this.#disposed) {
      return;
    }
    const signature = this.#stateSignature();
    if (signature === this.#lastStateSignature) {
      return;
    }
    this.#lastStateSignature = signature;
    this.#state.fire(this.getState());
  }

  #stateSignature(): string {
    const state = this.getState();
    return JSON.stringify([
      state.canUndo,
      state.canRedo,
      state.dirty,
      state.readOnly,
      state.running,
      state.access.edit.allowed,
      state.access.edit.allowed ? '' : state.access.edit.code,
      state.access.run.allowed,
      state.access.run.allowed ? '' : state.access.run.code,
    ]);
  }

  #documentKey(document: FusedDocument): string {
    let key = this.#keys.get(document);
    if (key === undefined) {
      key = canonicalJson(document);
      this.#keys.set(document, key);
    }
    return key;
  }

  #contentKey(document: FusedDocument): string {
    let key = this.#contentKeys.get(document);
    if (key === undefined) {
      key = canonicalJson({
        ...document,
        instances: document.instances.map(({ viewLayout, ...rest }) => {
          void viewLayout;
          return rest;
        }),
      });
      this.#contentKeys.set(document, key);
    }
    return key;
  }

  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(async () => {
      this.#assertAlive();
      try {
        return await run();
      } catch (cause) {
        const error = toSessionError(cause, 'edit/invalid-document');
        if (!this.#disposed && error.code !== 'session/disposed') {
          this.#errors.fire(error);
        }
        throw error;
      }
    });
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #assertAlive(): void {
    if (this.#disposed) {
      throw new FusedSessionError('session/disposed', 'The document session is disposed.');
    }
  }
}

/** Serializes the document for writing: readable strict JSON with a trailing newline. */
export function serializeFusedDocument(document: FusedDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function evaluateDecisions(
  access: IWorkbenchAccessProvider,
  document: FusedDocument,
): Promise<IDocumentAccess> {
  let decisions: IDocumentAccess | undefined;
  try {
    decisions = await access.evaluateDocument({ document });
  } catch (cause) {
    throw new FusedSessionError(
      'access/check-failed',
      'The access policy cannot evaluate this document.',
      { cause },
    );
  }
  return {
    edit: normalizeDecision(decisions?.edit, 'edit'),
    run: normalizeDecision(decisions?.run, 'run'),
  };
}

function normalizeDecision(decision: AccessDecision | undefined, label: string): AccessDecision {
  if (decision === undefined || decision === null || typeof decision !== 'object') {
    return denied('access/unavailable', `The access policy returned no ${label} decision.`);
  }
  if (decision.allowed === true) {
    return { allowed: true };
  }
  if (typeof decision.code === 'string' && typeof decision.message === 'string') {
    return { allowed: false, code: decision.code, message: decision.message };
  }
  return denied(
    'access/invalid-decision',
    `The access policy returned a malformed ${label} decision.`,
  );
}

function denied(code: string, message: string): DeniedDecision {
  return { allowed: false, code, message };
}

/** Identity of one locked release inside a document's dependency table. */
function lockKey(
  deviceId: string,
  dependency: { readonly version: string; readonly integrity: string },
): string {
  return `${deviceId}@${dependency.version}#${dependency.integrity}`;
}

/** Keeps the prepared-device map identity while every entry is the same verified object. */
function sameDevices(
  previous: ReadonlyMap<string, IPreparedDevice>,
  next: ReadonlyMap<string, IPreparedDevice>,
): boolean {
  if (previous === next) {
    return true;
  }
  if (previous.size !== next.size) {
    return false;
  }
  for (const [deviceId, device] of previous) {
    if (next.get(deviceId) !== device) {
      return false;
    }
  }
  return true;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value) ?? 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(',')}}`;
}
