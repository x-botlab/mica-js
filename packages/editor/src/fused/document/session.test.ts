import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceLock, FusedDocument, InstanceViewLayout } from '@mica-js/document/fused';
import { parseFusedDocument, parseStrictJson } from '@mica-js/document/fused';
import { FusedDocumentSession, serializeFusedDocument } from './session';
import type { IFusedDocumentSessionOptions } from './session';
import type { FusedSessionError } from './errors';
import { moveInstances } from './edits';
import { addWire as addWirePure } from './edits';
import { materializeAnchor, wirePolyline } from '../wiring';
import {
  ALLOW,
  createBench,
  connectedDocument,
  defaultPackages,
  denied,
  FLEX_MANIFEST,
  LED,
  LED_MANIFEST,
  LED_V2_MANIFEST,
  SWITCH_MANIFEST,
  URI,
  type IBench,
} from './test-helpers';

const LED_ID = '11111111-1111-4111-8111-111111111111';
const SWITCH_ID = '22222222-2222-4222-8222-222222222222';

const LAYOUT: InstanceViewLayout = {
  properties: { height: 120, collapsed: false },
  views: [{ viewId: 'panel', location: 'sidebar', height: 160, collapsed: false }],
};

/** Lets queued microtasks and timers run once. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const sessions: FusedDocumentSession[] = [];

async function open(options: IFusedDocumentSessionOptions): Promise<FusedDocumentSession> {
  const session = await FusedDocumentSession.open(options);
  sessions.push(session);
  return session;
}

/** Fails with the offending leg when any persisted wire is not orthogonal. */
async function expectOrthogonalWires(session: FusedDocumentSession): Promise<void> {
  const document = session.getDocument();
  const devices = await session.getPreparedDevices();
  for (const wire of document.wires) {
    const line = wirePolyline(document, devices, wire);
    expect(line, `wire ${wire.id} has unresolved anchors`).toBeDefined();
    const points = line ?? [];
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1]!;
      const b = points[index]!;
      expect(
        a.x === b.x || a.y === b.y,
        `wire ${wire.id} leg ${index} is diagonal: (${a.x},${a.y}) -> (${b.x},${b.y})`,
      ).toBe(true);
    }
  }
}

/** Deterministic UUID v4 factory so composed transactions stay comparable. */
function idFactory(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `00000000-0000-4000-8000-${String(count).padStart(12, '0')}`;
  };
}

const DIAGONAL_LED_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DIAGONAL_SWITCH_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Two devices whose aligned pins are diagonal to each other. */
function diagonalDocument(packages: ReturnType<typeof defaultPackages>): FusedDocument {
  const led = packages.lock(LED_MANIFEST);
  const sw = packages.lock(SWITCH_MANIFEST);
  return {
    version: 2,
    dependencies: {
      [led.id]: { version: led.version, integrity: led.integrity },
      [sw.id]: { version: sw.version, integrity: sw.integrity },
    },
    instances: [
      {
        id: DIAGONAL_LED_ID,
        device: LED,
        designator: 'D1',
        placement: { x: 0, y: 0, rotation: 0 },
      },
      {
        id: DIAGONAL_SWITCH_ID,
        device: 'demo:switch',
        designator: 'S1',
        placement: { x: 40, y: 25, rotation: 0 },
      },
    ],
    nodes: [],
    wires: [],
    labels: [],
    references: [],
  };
}

async function openConnected(): Promise<{
  readonly bench: IBench;
  readonly session: FusedDocumentSession;
}> {
  const packages = defaultPackages();
  const bench = createBench({ document: connectedDocument(packages) });
  return { bench, session: await open(bench.options()) };
}

afterEach(() => {
  while (sessions.length > 0) {
    sessions.pop()?.dispose();
  }
});

describe('FusedDocumentSession open', () => {
  it('loads the document, its packages and its topology without recording history', async () => {
    const packages = defaultPackages();
    const bench = createBench({ document: connectedDocument(packages) });
    const contents: FusedDocument[] = [];
    const session = await FusedDocumentSession.open(bench.options());
    sessions.push(session);
    session.onDidChangeContent((document) => contents.push(document));

    expect(session.getDocument().instances).toHaveLength(2);
    expect(session.getState()).toMatchObject({
      canUndo: false,
      canRedo: false,
      dirty: false,
      readOnly: false,
      running: false,
      canEditContent: true,
      canEditLayout: true,
    });
    expect(session.getTopology()?.nets).toHaveLength(2);
    const prepared = await session.getPreparedDevices();
    expect(prepared.get(LED)?.geometry.sizing).toBe('physical');
    expect(prepared.get(LED)?.files.files['art/body.png']).toBeDefined();
    expect(session.getPreparationError()).toBeUndefined();
    expect(contents).toHaveLength(0);
  });

  it('keeps a document with an unverifiable package browsable and read-only for edits', async () => {
    const document: FusedDocument = {
      version: 2,
      dependencies: {
        'demo:ghost': { version: '1.0.0', integrity: `sha256:${'0'.repeat(64)}` },
      },
      instances: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          device: 'demo:ghost',
          placement: { x: 0, y: 0, rotation: 0 },
        },
      ],
      nodes: [],
      wires: [],
      labels: [],
      references: [],
    };
    const bench = createBench({ document });
    const session = await open(bench.options());

    expect(session.getDocument().instances).toHaveLength(1);
    expect(session.getTopology()).toBeUndefined();
    expect(session.getPreparationError()).toMatchObject({ code: 'device/unavailable' });
    await expect(session.setProperty(LED_ID, 'limit', 1)).rejects.toMatchObject({
      code: 'device/unavailable',
    });
    await expect(session.getPreparedDevices()).rejects.toMatchObject({
      code: 'device/unavailable',
    });
  });

  it('rejects malformed JSON, unreadable files and a broken access policy', async () => {
    const duplicate = createBench();
    duplicate.files.contents.set(URI, new TextEncoder().encode('{"version":2,"version":2}'));
    await expect(FusedDocumentSession.open(duplicate.options())).rejects.toMatchObject({
      code: 'edit/invalid-document',
    });

    const missing = createBench();
    missing.files.contents.delete(URI);
    await expect(FusedDocumentSession.open(missing.options())).rejects.toMatchObject({
      code: 'load/failed',
    });

    const broken = createBench();
    broken.access.evaluate = async () => {
      throw new Error('policy offline');
    };
    await expect(FusedDocumentSession.open(broken.options())).rejects.toMatchObject({
      code: 'access/check-failed',
    });
  });
});

describe('device placement', () => {
  it('locks the release and allocates the smallest free designator', async () => {
    const bench = createBench();
    const session = await open(bench.options());
    const lock = bench.packages.lock(LED_MANIFEST);

    const first = await session.addDevice(lock, { x: 0, y: 0, rotation: 0 });
    const second = await session.addDevice(lock, { x: 20, y: 0, rotation: 0 });
    const document = session.getDocument();

    expect(document.instances.map((instance) => instance.id)).toEqual([first, second]);
    expect(document.instances.map((instance) => instance.designator)).toEqual(['D1', 'D2']);
    expect(document.dependencies[LED]).toEqual({
      version: lock.version,
      integrity: lock.integrity,
    });
    expect(session.getState().dirty).toBe(true);
  });

  it('requires width and height for a flexible device', async () => {
    const bench = createBench();
    const session = await open(bench.options());
    const lock = bench.packages.lock(FLEX_MANIFEST);

    await expect(session.addDevice(lock, { x: 0, y: 0, rotation: 0 })).rejects.toMatchObject({
      code: 'edit/invalid-request',
    });
    const id = await session.addDevice(lock, { x: 0, y: 0, rotation: 0, width: 10, height: 4 });
    const instance = session.getDocument().instances.find((entry) => entry.id === id);
    expect(instance?.placement).toEqual({ x: 0, y: 0, rotation: 0, width: 10, height: 4 });
  });

  it('never replaces a lock with another release', async () => {
    const packages = defaultPackages();
    const bench = createBench({ document: connectedDocument(packages) });
    const session = await open(bench.options());
    const before = session.getDocument();
    const errors: FusedSessionError[] = [];
    session.onDidError((error) => errors.push(error));

    await expect(
      session.addDevice(packages.lock(LED_V2_MANIFEST), { x: 0, y: 0, rotation: 0 }),
    ).rejects.toMatchObject({ code: 'document/locked-conflict' });

    expect(session.getDocument()).toBe(before);
    expect(session.getState().canUndo).toBe(false);
    expect(errors.map((error) => error.code)).toEqual(['document/locked-conflict']);
    expect(bench.access.additions).toHaveLength(0);
  });

  it('asks the access policy before adding a device', async () => {
    const bench = createBench();
    const session = await open(bench.options());
    bench.access.setAdd(denied('policy/premium', 'Upgrade to add devices.'));
    const before = session.getDocument();

    await expect(
      session.addDevice(bench.packages.lock(LED_MANIFEST), { x: 0, y: 0, rotation: 0 }),
    ).rejects.toMatchObject({ code: 'access/add-denied', decision: { allowed: false } });

    expect(bench.access.additions).toHaveLength(1);
    expect(bench.access.additions[0]?.device.id).toBe(LED);
    expect(session.getDocument()).toBe(before);
  });
});

describe('authorization', () => {
  it('denies every write path when edit permission is withdrawn', async () => {
    const { bench, session } = await openConnected();
    await session.setProperty(LED_ID, 'forwardResistance', 5);
    const clipboard = session.copy([{ kind: 'instance', id: LED_ID }]);
    expect(clipboard).toBeDefined();
    const before = session.getDocument();
    const errors: FusedSessionError[] = [];
    session.onDidError((error) => errors.push(error));

    bench.access.set({ edit: denied('access/paywall', 'Buy the full version.') });
    await session.refreshAccess();
    expect(session.getState().readOnly).toBe(true);
    expect(session.getState().canEditLayout).toBe(false);

    await expect(session.transact((document) => document)).rejects.toMatchObject({
      code: 'access/edit-denied',
    });
    await expect(session.undo()).rejects.toMatchObject({ code: 'access/edit-denied' });
    await expect(session.paste(clipboard!)).rejects.toMatchObject({ code: 'access/edit-denied' });
    await expect(session.save()).rejects.toMatchObject({ code: 'access/edit-denied' });
    await expect(session.setViewLayout(LED_ID, LAYOUT)).rejects.toMatchObject({
      code: 'access/edit-denied',
    });

    expect(session.getDocument()).toBe(before);
    expect(session.getState().canUndo).toBe(true);
    expect(errors.map((error) => error.code)).toEqual([
      'access/edit-denied',
      'access/edit-denied',
      'access/edit-denied',
      'access/edit-denied',
      'access/edit-denied',
    ]);
    expect(bench.files.writes).toHaveLength(0);
  });

  it('keeps browsing and the independent run permission with edit denied', async () => {
    const { bench, session } = await openConnected();
    bench.access.set({ edit: denied('access/paywall'), run: ALLOW });
    await session.refreshAccess();

    expect(session.getState()).toMatchObject({
      readOnly: true,
      canEditContent: false,
      canEditLayout: false,
    });
    expect(session.getAccess().run.allowed).toBe(true);
    expect(session.getDocument().instances).toHaveLength(2);

    await session.setRunning(true);
    expect(session.getState().running).toBe(true);
    await session.setRunning(false);
    expect(session.getState().running).toBe(false);
  });

  it('refuses to run without the run permission', async () => {
    const { bench, session } = await openConnected();
    bench.access.set({ run: denied('access/no-run', 'Running is not included.') });
    await session.refreshAccess();

    await expect(session.setRunning(true)).rejects.toMatchObject({
      code: 'access/run-denied',
    });
    expect(session.getState().running).toBe(false);
  });

  it('re-checks permission right before committing an asynchronous add', async () => {
    const packages = defaultPackages();
    const bench = createBench();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened!: () => void;
    const waiting = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const slow = {
      async open(lock: DeviceLock) {
        opened();
        await gate;
        return packages.registry.open(lock);
      },
    };
    const session = await open({
      uri: bench.uri,
      files: bench.files,
      devices: slow,
      access: bench.access,
    });

    const pending = session.addDevice(packages.lock(LED_MANIFEST), {
      x: 0,
      y: 0,
      rotation: 0,
    });
    await waiting;
    bench.access.set({ edit: denied('access/revoked', 'Signed out.') });
    release();

    await expect(pending).rejects.toMatchObject({ code: 'access/edit-denied' });
    expect(session.getDocument().instances).toHaveLength(0);
    expect(session.getState().readOnly).toBe(true);
  });

  it('fails closed when the access policy cannot be evaluated', async () => {
    const { bench, session } = await openConnected();
    bench.access.evaluate = async () => {
      throw new Error('policy offline');
    };
    const errors: FusedSessionError[] = [];
    session.onDidError((error) => errors.push(error));

    await expect(session.setProperty(LED_ID, 'forwardResistance', 5)).rejects.toMatchObject({
      code: 'access/check-failed',
    });
    expect(session.getState().readOnly).toBe(true);
    expect(session.getState().canEditContent).toBe(false);
    expect(errors.map((error) => error.code)).toEqual(['access/check-failed']);

    bench.access.evaluate = undefined;
    await session.refreshAccess();
    expect(session.getState().readOnly).toBe(false);
    await session.setProperty(LED_ID, 'forwardResistance', 5);
  });

  it('keeps unsaved content when permission is withdrawn', async () => {
    const { bench, session } = await openConnected();
    await session.setProperty(LED_ID, 'forwardResistance', 5);
    const before = session.getDocument();

    bench.access.set({ edit: denied('access/revoked') });
    await session.refreshAccess();

    expect(session.getDocument()).toBe(before);
    expect(session.getState().dirty).toBe(true);
    expect(session.getState().canUndo).toBe(true);
  });
});

describe('run locking', () => {
  it('blocks content but allows view layout while running', async () => {
    const { bench, session } = await openConnected();
    await session.setRunning(true);
    const before = session.getDocument();

    await expect(
      session.addDevice(bench.packages.lock(SWITCH_MANIFEST), { x: 0, y: 0, rotation: 0 }),
    ).rejects.toMatchObject({ code: 'access/running' });
    await expect(session.setProperty(LED_ID, 'forwardResistance', 5)).rejects.toMatchObject({
      code: 'access/running',
    });
    await expect(
      session.remove([{ kind: 'wire', id: before.wires[0]?.id ?? '' }]),
    ).rejects.toMatchObject({ code: 'access/running' });
    expect(session.getDocument()).toBe(before);

    await session.setViewLayout(LED_ID, LAYOUT);
    expect(session.getDocument().instances[0]?.viewLayout).toEqual(LAYOUT);
  });

  it('undoes only layout steps while running and stops at content', async () => {
    const { session } = await openConnected();
    await session.setProperty(LED_ID, 'forwardResistance', 5);
    await session.setRunning(true);
    await session.setViewLayout(LED_ID, LAYOUT);
    expect(session.getState().canUndo).toBe(true);

    await session.undo();
    expect(session.getDocument().instances[0]?.viewLayout).toBeUndefined();
    expect(session.getState().canUndo).toBe(false);
    expect(session.getState().canRedo).toBe(true);

    await expect(session.undo()).rejects.toMatchObject({ code: 'access/running' });

    await session.redo();
    expect(session.getDocument().instances[0]?.viewLayout).toEqual(LAYOUT);
    expect(session.getState().canUndo).toBe(true);

    await session.setRunning(false);
    await session.undo();
    expect(session.getDocument().instances[0]?.viewLayout).toBeUndefined();
    await session.undo();
    expect(session.getDocument().instances[0]?.properties).toBeUndefined();
  });

  it('allows saving while running and blocks a layout that changes content', async () => {
    const { bench, session } = await openConnected();
    await session.setRunning(true);
    await session.save();
    expect(bench.files.writes).toHaveLength(1);

    await expect(
      session.transact((document) => ({ ...document, display: { body: false } }), {
        layoutOnly: true,
      }),
    ).rejects.toMatchObject({ code: 'edit/layout-mismatch' });
    await expect(
      session.transact((document) => ({ ...document, display: { body: false } })),
    ).rejects.toMatchObject({ code: 'access/running' });
  });
});

describe('history and saving', () => {
  it('keeps one content event per transaction and none for a no-op', async () => {
    const { session } = await openConnected();
    let contents = 0;
    let states = 0;
    session.onDidChangeContent(() => {
      contents += 1;
    });
    session.onDidChangeState(() => {
      states += 1;
    });

    await session.setProperty(LED_ID, 'forwardResistance', 5);
    expect(contents).toBe(1);
    expect(states).toBe(1);

    await session.transact((document) => document);
    expect(contents).toBe(1);
    expect(states).toBe(1);
  });

  it('rejects a failed edit without touching content or history', async () => {
    const { session } = await openConnected();
    const before = session.getDocument();

    await expect(
      session.transact((document) => ({
        ...document,
        wires: [
          ...document.wires,
          {
            id: 'not-a-uuid',
            from: { kind: 'pin', instance: LED_ID, pin: 'anode' },
            to: { kind: 'pin', instance: SWITCH_ID, pin: 'a' },
            bends: [],
          },
        ],
      })),
    ).rejects.toMatchObject({ code: 'edit/invalid-document' });
    expect(session.getDocument()).toBe(before);
    expect(session.getState().canUndo).toBe(false);

    await expect(session.remove([{ kind: 'wire', id: 'missing' }])).rejects.toMatchObject({
      code: 'edit/unknown-target',
    });
    await expect(
      session.addWire(
        { kind: 'pin', instance: LED_ID, pin: 'not-a-pin' },
        { kind: 'pin', instance: SWITCH_ID, pin: 'a' },
      ),
    ).rejects.toMatchObject({ code: 'edit/invalid-document' });
    expect(session.getDocument()).toBe(before);
  });

  it('keeps the saved marker across save, undo and redo', async () => {
    const { session } = await openConnected();
    await session.setProperty(LED_ID, 'forwardResistance', 5);
    await session.save();
    expect(session.getState().dirty).toBe(false);

    await session.setProperty(LED_ID, 'forwardResistance', 10);
    expect(session.getState().dirty).toBe(true);
    await session.undo();
    expect(session.getState().dirty).toBe(false);
    await session.undo();
    expect(session.getState().dirty).toBe(true);
    await session.redo();
    expect(session.getState().dirty).toBe(false);
  });

  it('writes the saved snapshot while a queued edit keeps the document dirty', async () => {
    const { bench, session } = await openConnected();
    const saved = serializeFusedDocument(session.getDocument());
    let release!: () => void;
    bench.files.writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const saving = session.save();
    const editing = session.setProperty(LED_ID, 'forwardResistance', 5);
    release();
    await saving;
    await editing;

    expect(bench.files.text(URI)).toBe(saved);
    expect(() => parseFusedDocument(parseStrictJson(saved))).not.toThrow();
    expect(session.getState().dirty).toBe(true);
    expect(session.getState().canUndo).toBe(true);
  });

  it('persists and restores view layouts', async () => {
    const { session } = await openConnected();
    await session.setViewLayout(LED_ID, LAYOUT);
    expect(session.getDocument().instances[0]?.viewLayout).toEqual(LAYOUT);

    await expect(
      session.setViewLayout(LED_ID, {
        properties: { height: 120, collapsed: false },
        views: [{ viewId: 'missing', location: 'sidebar', height: 120, collapsed: false }],
      }),
    ).rejects.toMatchObject({ code: 'edit/invalid-document' });

    await session.setViewLayout(LED_ID, undefined);
    expect(session.getDocument().instances[0]?.viewLayout).toBeUndefined();
  });
});

describe('connections', () => {
  it('keeps wire identity and connectivity while instances move or rotate', async () => {
    const { session } = await openConnected();
    const wireBefore = session.getDocument().wires[0];
    const netsBefore = session.getTopology()?.nets;

    await session.moveInstances([LED_ID, SWITCH_ID], { x: 5, y: -3 });
    let document = session.getDocument();
    expect(document.wires[0]?.id).toBe(wireBefore?.id);
    expect(document.wires[0]?.from).toEqual(wireBefore?.from);
    expect(document.wires[0]?.to).toEqual(wireBefore?.to);
    await expectOrthogonalWires(session);

    await session.rotateInstances([LED_ID], 90);
    document = session.getDocument();
    expect(document.wires[0]?.id).toBe(wireBefore?.id);
    expect(document.wires[0]?.from).toEqual(wireBefore?.from);
    expect(document.wires[0]?.to).toEqual(wireBefore?.to);
    expect(document.instances[0]?.placement).toMatchObject({ x: 25, y: 7, rotation: 90 });
    expect(document.instances[1]?.placement).toMatchObject({ x: 55, y: 7, rotation: 0 });
    await expectOrthogonalWires(session);
    expect(session.getTopology()?.nets).toEqual(netsBefore);
  });

  it('adds wires, labels, references and nodes through the session', async () => {
    const { session } = await openConnected();
    const nodeId = await session.addNode({ x: 100, y: 100 }, 'junction');
    const wireId = await session.addWire(
      { kind: 'pin', instance: LED_ID, pin: 'cathode' },
      { kind: 'node', node: nodeId },
      [{ x: 80, y: 90 }],
    );
    const labelId = await session.addLabel({ kind: 'node', node: nodeId }, 'OUT', {
      offset: { x: 2, y: 2 },
    });
    const referenceId = await session.addReference({ kind: 'node', node: nodeId }, 5, 'power', {
      rotation: 90,
    });
    const freeNode = await session.addNode({ x: 200, y: 200 }, 'free');
    const symbolId = await session.addReference({ kind: 'node', node: freeNode }, 3, 'power', {
      label: { name: 'VBUS', offset: { x: 1, y: 1 } },
    });

    const document = session.getDocument();
    expect(document.nodes.find((node) => node.id === nodeId)?.kind).toBe('junction');
    expect(document.wires.find((wire) => wire.id === wireId)?.bends).toEqual([
      { x: 26, y: 90 },
      { x: 100, y: 90 },
    ]);
    expect(document.labels.find((label) => label.id === labelId)?.offset).toEqual({ x: 2, y: 2 });
    expect(document.references.find((reference) => reference.id === referenceId)).toMatchObject({
      voltage: 5,
      symbol: 'power',
      rotation: 90,
    });
    expect(document.references.find((reference) => reference.id === symbolId)).toMatchObject({
      voltage: 3,
      label: { name: 'VBUS', offset: { x: 1, y: 1 } },
    });
    expect(session.getTopology()?.nets.some((net) => net.voltage === 5)).toBe(true);

    await expect(
      session.addReference({ kind: 'node', node: nodeId }, 5, 'ground'),
    ).rejects.toMatchObject({ code: 'edit/invalid-request' });
  });

  it('cascades removals and prunes an emptied symbol anchor', async () => {
    const { session } = await openConnected();
    await session.remove([{ kind: 'instance', id: SWITCH_ID }]);
    let document = session.getDocument();
    expect(document.wires).toHaveLength(0);
    expect(document.references).toHaveLength(0);
    expect(document.labels).toHaveLength(1);

    const nodeId = await session.addNode({ x: 100, y: 100 }, 'free');
    const referenceId = await session.addReference({ kind: 'node', node: nodeId }, 0, 'ground');
    await session.remove([{ kind: 'reference', id: referenceId }]);
    document = session.getDocument();
    expect(document.nodes.find((node) => node.id === nodeId)).toBeUndefined();

    const keptNode = await session.addNode({ x: 1, y: 1 }, 'junction');
    await session.addWire(
      { kind: 'pin', instance: LED_ID, pin: 'cathode' },
      {
        kind: 'node',
        node: keptNode,
      },
    );
    const keptReference = await session.addReference({ kind: 'node', node: keptNode }, 0, 'ground');
    await session.remove([{ kind: 'reference', id: keptReference }]);
    document = session.getDocument();
    expect(document.nodes.find((node) => node.id === keptNode)).toBeDefined();
  });

  it('copies the selected subgraph and pastes it with new identities', async () => {
    const { session } = await openConnected();
    const onlyLed = session.copy([{ kind: 'instance', id: LED_ID }]);
    expect(onlyLed?.instances).toHaveLength(1);
    expect(onlyLed?.wires).toHaveLength(0);

    const both = session.copy([
      { kind: 'instance', id: LED_ID },
      { kind: 'instance', id: SWITCH_ID },
    ]);
    expect(both?.wires).toHaveLength(1);
    expect(both?.labels).toHaveLength(1);
    expect(both?.references).toHaveLength(1);

    await session.paste(both!, { x: 10, y: 10 });
    const document = session.getDocument();
    expect(document.instances).toHaveLength(4);
    expect(document.instances.map((instance) => instance.designator)).toEqual([
      'D1',
      'S1',
      'D2',
      'S2',
    ]);
    expect(document.wires).toHaveLength(2);
    const pasted = document.wires[1];
    const copies = new Set([document.instances[2]?.id ?? '', document.instances[3]?.id ?? '']);
    expect(pasted?.from.kind === 'pin' && copies.has(pasted.from.instance)).toBe(true);
    expect(pasted?.to.kind === 'pin' && copies.has(pasted.to.instance)).toBe(true);
    expect(pasted?.bends).toEqual([{ x: 45, y: 20 }]);
    expect(document.labels[1]?.target).toEqual({
      kind: 'pin',
      instance: document.instances[2]?.id,
      pin: 'anode',
    });
    expect(document.references[1]?.target).toEqual({
      kind: 'pin',
      instance: document.instances[3]?.id,
      pin: 'b',
    });
  });
});

describe('instance identity', () => {
  it('renames a designator and rejects one another instance owns', async () => {
    const { session } = await openConnected();
    await session.renameDesignator(LED_ID, 'D7');
    expect(session.getDocument().instances[0]?.designator).toBe('D7');

    await expect(session.renameDesignator(SWITCH_ID, 'D7')).rejects.toMatchObject({
      code: 'edit/duplicate-designator',
    });
    await expect(session.renameDesignator(SWITCH_ID, '')).rejects.toMatchObject({
      code: 'edit/invalid-request',
    });
    expect(session.getDocument().instances[1]?.designator).toBe('S1');

    let contents = 0;
    session.onDidChangeContent(() => {
      contents += 1;
    });
    await session.renameDesignator(LED_ID, 'D7');
    expect(contents).toBe(0);
  });

  it('rotates one instance by the drag delta', async () => {
    const { session } = await openConnected();
    await session.rotateInstance(LED_ID, 30);
    expect(session.getDocument().instances[0]?.placement.rotation).toBe(30);
    await session.rotateInstance(LED_ID, -60);
    expect(session.getDocument().instances[0]?.placement.rotation).toBe(330);
  });

  it('keeps the prepared device map identity across content edits', async () => {
    const { session } = await openConnected();
    const first = await session.getPreparedDevices();
    const loaded = session.getDevices().getLoadedDevices();

    await session.setProperty(LED_ID, 'forwardResistance', 5);
    await session.rotateInstance(LED_ID, 15);

    expect(await session.getPreparedDevices()).toBe(first);
    expect(session.getDevices().getLoadedDevices()).toBe(loaded);
    expect([...first.keys()]).toEqual([LED, 'demo:switch']);
  });
});

describe('properties', () => {
  it('stores and drops overrides, rejecting values the contract refuses', async () => {
    const { session } = await openConnected();
    await session.setProperty(LED_ID, 'forwardResistance', 250);
    expect(session.getDocument().instances[0]?.properties).toEqual({ forwardResistance: 250 });

    await expect(
      session.setProperty(LED_ID, 'forwardResistance', { bad: true } as never),
    ).rejects.toMatchObject({ code: 'edit/invalid-document' });
    expect(session.getDocument().instances[0]?.properties).toEqual({ forwardResistance: 250 });

    await session.removeProperty(LED_ID, 'forwardResistance');
    expect(session.getDocument().instances[0]?.properties).toBeUndefined();
  });
});

describe('central authorization', () => {
  it('checks device addition for an instance a generic transaction introduces', async () => {
    const { bench, session } = await openConnected();
    bench.access.setAdd(denied('policy/premium', 'Upgrade to add devices.'));
    const before = session.getDocument();
    const added = {
      id: '99999999-9999-4999-8999-999999999999',
      device: LED,
      designator: 'D9',
      placement: { x: 0, y: 0, rotation: 0 },
    };

    await expect(
      session.transact((document) => ({
        ...document,
        instances: [...document.instances, added],
      })),
    ).rejects.toMatchObject({ code: 'access/add-denied' });

    expect(session.getDocument()).toBe(before);
    expect(session.getState().canUndo).toBe(false);
    expect(bench.access.additions).toHaveLength(1);
    expect(bench.access.additions[0]?.device.id).toBe(LED);
    expect(bench.access.additions[0]?.document.instances).toHaveLength(3);
  });

  it('checks device addition for a release a generic transaction introduces', async () => {
    const { bench, session } = await openConnected();
    bench.access.setAdd(denied('policy/premium', 'Upgrade to add devices.'));
    const before = session.getDocument();
    const lock = bench.packages.lock(FLEX_MANIFEST);

    await expect(
      session.transact(() => ({
        ...before,
        dependencies: {
          ...before.dependencies,
          [lock.id]: { version: lock.version, integrity: lock.integrity },
        },
        instances: [
          ...before.instances,
          {
            id: '99999999-9999-4999-8999-999999999999',
            device: lock.id,
            designator: 'X1',
            placement: { x: 0, y: 0, rotation: 0, width: 10, height: 4 },
          },
        ],
      })),
    ).rejects.toMatchObject({ code: 'access/add-denied' });

    expect(session.getDocument()).toBe(before);
    expect(bench.access.additions.map((context) => context.device.id)).toEqual([lock.id]);
  });

  it('checks device addition when redo restores an instance after entitlement loss', async () => {
    const bench = createBench();
    const session = await open(bench.options());
    const lock = bench.packages.lock(LED_MANIFEST);
    const instanceId = await session.addDevice(lock, { x: 0, y: 0, rotation: 0 });
    await session.undo();
    expect(session.getDocument().instances).toHaveLength(0);

    bench.access.setAdd(denied('access/premium', 'Buy to add devices.'));
    const before = session.getDocument();
    await expect(session.redo()).rejects.toMatchObject({ code: 'access/add-denied' });

    expect(session.getDocument()).toBe(before);
    expect(session.getState().canRedo).toBe(true);
    expect(bench.access.additions.at(-1)?.document.instances).toHaveLength(1);

    bench.access.setAdd(ALLOW);
    await session.redo();
    expect(session.getDocument().instances[0]?.id).toBe(instanceId);
  });

  it('blocks writes until a provider change has been evaluated', async () => {
    const { bench, session } = await openConnected();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    let held = true;
    bench.access.evaluate = async () => {
      if (held) {
        held = false;
        started();
        await gate;
      }
      return bench.access.current();
    };

    bench.access.set({ edit: ALLOW });
    await startedP;
    const before = session.getDocument();
    let settled = false;
    const write = session.setProperty(LED_ID, 'forwardResistance', 5);
    void write.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await tick();
    await tick();
    expect(settled).toBe(false);
    expect(session.getDocument()).toBe(before);

    bench.access.setSilent({ edit: denied('access/revoked', 'Signed out.') });
    release();
    await expect(write).rejects.toMatchObject({ code: 'access/edit-denied' });
    expect(session.getDocument()).toBe(before);
    expect(session.getState().readOnly).toBe(true);
  });

  it('reports a failed provider refresh and fails closed', async () => {
    const { bench, session } = await openConnected();
    const errors: FusedSessionError[] = [];
    session.onDidError((error) => errors.push(error));
    bench.access.evaluate = async () => {
      throw new Error('policy offline');
    };

    bench.access.set({ edit: ALLOW });
    for (let attempt = 0; attempt < 20 && errors.length === 0; attempt += 1) {
      await tick();
    }

    expect(errors[0]?.code).toBe('access/check-failed');
    expect(session.getState().readOnly).toBe(true);
    const before = session.getDocument();
    await expect(session.setProperty(LED_ID, 'forwardResistance', 5)).rejects.toMatchObject({
      code: 'access/edit-denied',
    });
    expect(session.getDocument()).toBe(before);
  });

  it('authorizes save after the awaited evaluation, never at queue start', async () => {
    const { bench, session } = await openConnected();
    await session.setProperty(LED_ID, 'forwardResistance', 5);
    const content = session.getDocument();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    let held = true;
    bench.access.evaluate = async () => {
      if (held) {
        held = false;
        started();
        await gate;
      }
      return bench.access.current();
    };

    const saving = session.save();
    await startedP;
    bench.access.setSilent({ edit: denied('access/revoked', 'Signed out.') });
    release();

    await expect(saving).rejects.toMatchObject({ code: 'access/edit-denied' });
    expect(bench.files.writes).toHaveLength(0);
    expect(session.getDocument()).toBe(content);
    expect(session.getState().dirty).toBe(true);
  });
});

describe('orthogonal routing', () => {
  async function openDiagonal(): Promise<FusedDocumentSession> {
    const packages = defaultPackages();
    const bench = createBench({ document: diagonalDocument(packages) });
    return open(bench.options());
  }

  async function connectDiagonal(session: FusedDocumentSession): Promise<string> {
    return session.addWire(
      { kind: 'pin', instance: DIAGONAL_LED_ID, pin: 'cathode' },
      { kind: 'pin', instance: DIAGONAL_SWITCH_ID, pin: 'a' },
    );
  }

  it('routes a new wire with a long-axis-first elbow', async () => {
    const session = await openDiagonal();
    const wireId = await connectDiagonal(session);

    const wire = session.getDocument().wires.find((candidate) => candidate.id === wireId);
    expect(wire?.bends).toEqual([{ x: 34, y: 0 }]);
    await expectOrthogonalWires(session);
  });

  it('reroutes the attached wire when an instance moves diagonally', async () => {
    const session = await openDiagonal();
    await connectDiagonal(session);
    const before = session.getDocument().wires[0]!;

    await session.moveInstance(DIAGONAL_SWITCH_ID, { x: 60, y: 40 });
    const document = session.getDocument();
    const wire = document.wires[0]!;
    expect(wire.id).toBe(before.id);
    expect(wire.from).toEqual(before.from);
    expect(wire.to).toEqual(before.to);
    await expectOrthogonalWires(session);

    const line = wirePolyline(document, await session.getPreparedDevices(), wire)!;
    expect(line[0]).toEqual({ x: 6, y: 0 });
    expect(line[line.length - 1]).toEqual({ x: 54, y: 40 });

    await session.undo();
    expect(session.getDocument().wires[0]).toEqual(before);
  });

  it('reroutes wires when an instance rotates to a fractional angle', async () => {
    const session = await openDiagonal();
    await connectDiagonal(session);
    const before = session.getDocument().wires[0]!;

    await session.rotateInstance(DIAGONAL_LED_ID, 45);
    await expectOrthogonalWires(session);

    const document = session.getDocument();
    const wire = document.wires[0]!;
    expect(wire.id).toBe(before.id);
    expect(wire.from).toEqual(before.from);
    expect(wire.to).toEqual(before.to);

    const line = wirePolyline(document, await session.getPreparedDevices(), wire)!;
    const diagonalStep = Math.PI / 4;
    expect(line[0]?.x).toBeCloseTo(6 * Math.cos(diagonalStep), 10);
    expect(line[0]?.y).toBeCloseTo(6 * Math.sin(diagonalStep), 10);
    expect(line[line.length - 1]).toEqual({ x: 34, y: 25 });
    expect(line.some((point) => !Number.isInteger(point.x) || !Number.isInteger(point.y))).toBe(
      true,
    );
  });

  it('reroutes a move made by a generic transaction', async () => {
    const session = await openDiagonal();
    const wireId = await connectDiagonal(session);

    await session.transact((document) =>
      moveInstances(document, [DIAGONAL_SWITCH_ID], { x: -10, y: 7 }),
    );

    expect(session.getDocument().wires[0]?.id).toBe(wireId);
    await expectOrthogonalWires(session);
  });

  it('preserves orthogonal wire geometry and repairs a legacy diagonal leg', async () => {
    const packages = defaultPackages();
    const document = connectedDocument(packages);
    const legacy: FusedDocument = {
      ...document,
      wires: document.wires.map((wire) => ({ ...wire, bends: [{ x: 35, y: 15 }] })),
    };
    const bench = createBench({ document: legacy });
    const session = await open(bench.options());
    const wireBefore = session.getDocument().wires[0]!;

    await session.setProperty(LED_ID, 'forwardResistance', 10);
    const repaired = session.getDocument().wires[0]!;
    expect(repaired.id).toBe(wireBefore.id);
    expect(repaired.from).toEqual(wireBefore.from);
    expect(repaired.to).toEqual(wireBefore.to);
    await expectOrthogonalWires(session);

    const geometric = session.getDocument().wires[0]!;
    await session.setProperty(LED_ID, 'forwardResistance', 20);
    expect(session.getDocument().wires[0]?.bends).toEqual(geometric.bends);
  });
});

describe('anchor materialization', () => {
  it('splits a tapped wire and joins a new wire in one undo step', async () => {
    const { session } = await openConnected();
    const devices = await session.getPreparedDevices();
    const before = session.getDocument();
    const host = before.wires[0]!;
    let addedId = '';

    await session.transact((current) => {
      const createId = idFactory();
      const tap = materializeAnchor(current, { x: 29, y: 10 }, devices, createId);
      const added = addWirePure(
        tap.document,
        tap.endpoint,
        { kind: 'pin', instance: SWITCH_ID, pin: 'b' },
        [],
        createId,
      );
      addedId = added.wireId;
      return added.document;
    });

    const document = session.getDocument();
    expect(document.wires.map((wire) => wire.id)).not.toContain(host.id);
    expect(document.wires).toHaveLength(3);
    expect(document.nodes[0]).toMatchObject({ kind: 'junction', x: 29, y: 10 });
    expect(document.wires.some((wire) => wire.id === addedId)).toBe(true);
    await expectOrthogonalWires(session);

    await session.undo();
    expect(session.getDocument()).toEqual(before);
  });

  it('persists nothing when a materialized anchor is abandoned', async () => {
    const { session } = await openConnected();
    const devices = await session.getPreparedDevices();
    const before = session.getDocument();

    const preview = materializeAnchor(before, { x: 29, y: 10 }, devices, idFactory());

    expect(preview.document.wires).toHaveLength(2);
    expect(before.wires).toHaveLength(1);
    expect(before.nodes).toHaveLength(0);
    expect(session.getDocument()).toBe(before);
    expect(session.getState().canUndo).toBe(false);
  });
});
