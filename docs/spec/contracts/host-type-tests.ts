/** 仅供 tsc 的 D5 合同检查，不执行器件或仿真运行时。 */
import { createDeviceBuilder, types } from './builder';
import {
  createBoard,
  createDeviceLibrary,
  SimulationError,
  type Board,
  type BoardDescription,
  type BoardOptions,
  type BorrowedBytes,
  type ChannelMessage,
  type DeviceBatch,
  type DeviceContext,
  type DeviceFactory,
  type InputChannel,
  type InputNotification,
  type Notification,
  type ReadonlyBytes,
  type RuntimeDiagnostic,
} from './host';
import type { Disposable, Event } from '@mica-js/core/lifecycle';

type NodeContext = DeviceContext<
  { readonly count: number; readonly image: ReadonlyBytes },
  {
    readonly request: InputChannel<number>;
    readonly refresh: InputNotification;
    readonly bytes: InputChannel<Uint8Array>;
  },
  { readonly visible: BorrowedBytes }
>;
type NodeBatch = DeviceBatch<{
  readonly result: readonly ChannelMessage<number>[];
  readonly changed: Notification | null;
  readonly copies: readonly ChannelMessage<ReadonlyBytes>[];
}>;

const createNode: DeviceFactory<NodeContext, NodeBatch> = (context) => {
  context.inputs.request.send(context.props.count);
  context.inputs.refresh.notify();
  context.inputs.bytes.send(context.props.image.slice());
  const jit = context.attachJit({
    entry: 'step',
    code: 'code',
    pc: 'position',
    translate(input, builder) {
      const byte: number | undefined = input.code[0];
      void byte;
      builder.instruction({ pc: input.pc, nextPc: input.pc + 1 }, (body) => body.stop());
      return builder.finish();
    },
  });
  context.loadBytes('code', new Uint8Array([1, 2]));
  const subscription = context.topics.onDidReceive((message) => {
    const payload: unknown = message.payload;
    void payload;
  });
  return {
    sync(batch) {
      const value: number | undefined = batch.outputs.result[0]?.value;
      const bytes: ReadonlyBytes | undefined = batch.outputs.copies[0]?.value;
      const view: BorrowedBytes = context.memory.visible;
      const owned: Uint8Array = view.slice();
      void [value, bytes, owned];
    },
    dispose() {
      subscription.dispose();
      jit.dispose();
    },
  };
};

const builder = createDeviceBuilder({ name: 'Node' });
builder.property({ name: 'count', type: types.number, default: 1 });
builder.property({ name: 'image', type: types.bytes, default: new Uint8Array() });
builder.state({ name: 'position', type: types.number, initial: 0 });
builder.memory({ name: 'code', length: 4 });
builder.memory({ name: 'visible', public: true, length: 4 });
builder.pin({ name: 'reference' });
builder.channel({ name: 'request', direction: 'input', type: types.number, capacity: 4 });
builder.channel({
  name: 'bytes',
  direction: 'input',
  type: types.bytes,
  maxLength: 4,
  capacity: 4,
});
builder.notification({ name: 'refresh', direction: 'input' });
builder.channel({ name: 'result', direction: 'output', type: types.number, capacity: 4 });
builder.channel({
  name: 'copies',
  direction: 'output',
  type: types.bytes,
  maxLength: 4,
  capacity: 4,
});
builder.notification({ name: 'changed', direction: 'output' });
const model = builder.finish();
const library = createDeviceLibrary([{ id: 'example/Node', model, create: createNode }]);
const description: BoardDescription = {
  instances: [
    {
      id: 'node',
      type: 'example/Node',
      props: { count: 1, image: new Uint8Array() },
      randomState: [1, 2, 3, 4],
    },
  ],
  nets: [{ id: 'ground', voltage: 0, pins: [{ instance: 'node', pin: 'reference' }] }],
};
const validOptions: BoardOptions = { seed: 0 };
const onlyOption: Record<keyof BoardOptions, number> = { seed: 0 };
void onlyOption;
const board: Board = createBoard(library, description, validOptions);
const errorEvent: Event<RuntimeDiagnostic> = board.onDidError;
const diagnosticEvent: Event<RuntimeDiagnostic> = board.onDidDiagnostic;
const subscription: Disposable = errorEvent((diagnostic) => {
  const error = new SimulationError(diagnostic);
  const sameCode: RuntimeDiagnostic['code'] = error.code;
  void sameCode;
});
const noBatch: void = board.runUntil(100);
const noDisposeResult: void = board.dispose();
void [diagnosticEvent, subscription, noBatch, noDisposeResult];

function rejectsWrongShapes(
  context: NodeContext,
  batch: NodeBatch,
  snapshot: ReadonlyBytes,
  borrowed: BorrowedBytes,
  options: BoardOptions,
) {
  // @ts-expect-error There is no reset operation; recovery creates another board.
  board.reset();
  // @ts-expect-error Time is observed, not assigned by the host.
  board.time = 0;
  // @ts-expect-error State is observed, not assigned by the host.
  board.status = 'ready';
  // @ts-expect-error The new library field is model, not definition.
  createDeviceLibrary([{ id: 'x', definition: model, create: createNode }]);
  // @ts-expect-error The library receives DeviceIR, not DDL source text.
  createDeviceLibrary([{ id: 'x', model: 'device Node {}', create: createNode }]);
  // @ts-expect-error Net endpoints use named objects, not tuples.
  const badNet: BoardDescription = { instances: [], nets: [{ id: 'n', pins: [['node', 'pin']] }] };
  const badGround: BoardDescription = {
    instances: [],
    // @ts-expect-error Ground is expressed with voltage: 0.
    nets: [{ id: 'n', pins: [], ground: true }],
  };
  // @ts-expect-error Both required arrays are present even on an empty board.
  createBoard(library, { instances: [] });
  // @ts-expect-error The override has exactly four words.
  createBoard(library, { instances: [{ id: 'n', type: 'x', randomState: [1, 2, 3] }], nets: [] });
  // @ts-expect-error There is no arbitrary resource limit configuration.
  createBoard(library, description, { maxMemoryBytes: 10 });
  // @ts-expect-error exactOptionalPropertyTypes distinguishes omission from undefined.
  const undefinedSeed: BoardOptions = { seed: undefined };
  // @ts-expect-error Explicit null is not a seed.
  const nullSeed: BoardOptions = { seed: null };
  // @ts-expect-error Context properties are fixed values.
  context.props.count = 3;
  // @ts-expect-error Input channel payloads keep their generated types.
  context.inputs.request.send(false);
  // @ts-expect-error Byte input accepts Uint8Array, not a readonly byte snapshot.
  context.inputs.bytes.send(snapshot);
  // @ts-expect-error Code loading accepts Uint8Array, not an ArrayBuffer.
  context.loadBytes('code', new ArrayBuffer(2));
  // @ts-expect-error Outputs are delivered in batches, not exposed as context endpoints.
  void context.outputs.result;
  // @ts-expect-error Batches cannot append output messages.
  batch.outputs.result.push({ time: 0, value: 1 });
  // @ts-expect-error Output message metadata is immutable.
  batch.outputs.result[0]!.time = 1;
  // @ts-expect-error Snapshots hide the mutable backing buffer.
  void snapshot.buffer;
  // @ts-expect-error Neither snapshot nor borrowed view exposes indexed writes.
  borrowed[0] = 1;
  // @ts-expect-error A borrowed view is not a retainable snapshot.
  const retained: ReadonlyBytes = borrowed;
  // @ts-expect-error A snapshot is not a live borrowed view.
  const live: BorrowedBytes = snapshot;
  // @ts-expect-error The SDK does not expose an onDiagnostic callback option.
  createBoard(library, description, { ...options, onDiagnostic() {} });
  void [badNet, badGround, undefinedSeed, nullSeed, retained, live];
}
void rejectsWrongShapes;
