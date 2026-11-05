import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDeviceBuilder } from '../../../device-model/dist/index.js';
import { createUart } from '../../../../tests/conformance/devices/uart/uart-adapter.js';

export const digitalNames = ['uart', 'cpu-irq'];

const framesPerDirection = 8;
const uartBatchTime = framesPerDirection * 100 + 10;
const endpoint = (instance, pin) => ({ instance, pin });

function disposeOnce(board) {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    board.dispose();
  };
}

async function prepareUart({ size, compile, createDeviceLibrary, createBoard }) {
  const model = await compile(
    await readFile(
      new URL('../../../../tests/conformance/devices/uart/uart.ddl', import.meta.url),
      'utf8',
    ),
  );
  const ids = Array.from({ length: size * 2 }, (_, index) => `uart-${index}`);
  const description = {
    instances: ids.map((id) => ({ id, type: 'uart', props: { bitTime: 10 } })),
    nets: [
      { id: 'supply', pins: ids.map((id) => endpoint(id, 'supply')), voltage: 3.3 },
      { id: 'reference', pins: ids.map((id) => endpoint(id, 'reference')), voltage: 0 },
      ...Array.from({ length: size }, (_, pair) =>
        [0, 1].map((direction) => ({
          id: `serial-${pair}-${direction}`,
          pins: [
            endpoint(ids[pair * 2 + direction], 'tx'),
            endpoint(ids[pair * 2 + (1 - direction)], 'rx'),
          ],
        })),
      ).flat(),
    ],
  };
  let assembling;
  const library = createDeviceLibrary([
    {
      id: 'uart',
      model,
      create(context) {
        const state = assembling;
        const index = state.contexts.length;
        state.contexts.push(context);
        const paired = createUart(context);
        return {
          sync(batch) {
            state.received[index].push(...batch.outputs.received);
            state.counts[index] += batch.outputs.received.length;
            state.dropped += batch.outputs.txDropped.length;
            paired.sync(batch);
          },
          dispose() {
            paired.dispose();
          },
        };
      },
    },
  ]);
  return {
    unit: 'frames',
    description:
      `${size} independent electrical full-duplex UART pairs, real uart.ddl at bitTime=10; ` +
      '8 frames per direction per step with a full stop bit and 10ps idle gap. ' +
      'Driver timing includes deterministic input generation, SDK input sends, real paired ' +
      'adapter sync/topic publication and bounded per-step evidence capture; verification is separate.',
    create() {
      const state = {
        contexts: [],
        received: ids.map(() => []),
        counts: ids.map(() => 0),
        dropped: 0,
      };
      let steps = 0;
      let board;
      assembling = state;
      try {
        board = createBoard(library, description);
      } finally {
        assembling = undefined;
      }
      return {
        board,
        operationsPerStep: size * 2 * framesPerDirection,
        initialize() {
          board.runUntil(10);
          assert.equal(board.status, 'ready');
          assert.equal(board.time, 10);
          assert.equal(state.contexts.length, ids.length);
          assert.ok(state.counts.every((count) => count === 0));
          assert.equal(state.dropped, 0);
        },
        step() {
          for (let instance = 0; instance < ids.length; instance++) {
            state.received[instance].length = 0;
            const bytes = new Uint8Array(framesPerDirection);
            for (let frame = 0; frame < bytes.length; frame++) {
              const ordinal = steps * framesPerDirection + frame;
              bytes[frame] = (instance * 67 + ordinal * 29 + Math.floor(ordinal / 256) * 17) % 256;
            }
            state.contexts[instance].inputs.transmit.send(bytes);
          }
          steps++;
          board.runUntil(10 + steps * uartBatchTime);
        },
        verify(completedSteps) {
          assert.equal(steps, completedSteps);
          assert.equal(board.time, 10 + completedSteps * uartBatchTime);
          assert.equal(board.status, 'ready');
          assert.equal(state.dropped, 0, 'UART TX must never drop bytes');
          for (let receiver = 0; receiver < ids.length; receiver++) {
            const messages = state.received[receiver];
            const sender = receiver % 2 === 0 ? receiver + 1 : receiver - 1;
            assert.equal(messages.length, framesPerDirection, `UART ${receiver} frame count`);
            assert.equal(state.counts[receiver], completedSteps * framesPerDirection);
            for (let frame = 0; frame < framesPerDirection; frame++) {
              const ordinal = (completedSteps - 1) * 8 + frame;
              const expectedByte =
                (67 * sender + 29 * ordinal + 17 * Math.floor(ordinal / 256)) & 255;
              assert.deepEqual(messages[frame], {
                time: 10 + (completedSteps - 1) * 810 + 95 + frame * 100,
                value: { value: expectedByte, framingError: false, unknown: false },
              });
            }
          }
        },
        dispose: disposeOnce(board),
      };
    },
  };
}

async function prepareCpu({ size, createDeviceLibrary, createBoard }) {
  const { observedProcessor, processorFactory } =
    await import('../../../../tests/conformance/devices/processor-support.mjs');
  const model = observedProcessor({ createDeviceBuilder });
  const firmware = new Uint8Array(256);
  firmware.set([0x20, 0x30, 0x00]); // WAIT; JMP 0.
  firmware.set([0x11, 0x01, 0x40], 128); // ADDI 1; IRET.
  const description = {
    instances: Array.from({ length: size }, (_, index) => ({
      id: `cpu-${index}`,
      type: 'processor',
      props: { firmware },
    })),
    nets: [],
  };
  let assembling;
  const library = createDeviceLibrary([
    { id: 'processor', model, create: (context) => assembling(context) },
  ]);
  return {
    unit: 'interrupts',
    description:
      `${size} real minimal processors executing WAIT/JMP 0 with ADDI 1/IRET at IRQ vector 128; ` +
      'one handled IRQ per CPU per step, including real paired topic/notification delivery and JIT. ' +
      'Observed fixture instrumentation adds six public-evidence reactions; translator trace ' +
      'capture is included and cleared on every sync. Verification is outside driver timing.',
    create() {
      const contexts = [];
      const translations = [];
      const disposed = [];
      let steps = 0;
      let board;
      assembling = processorFactory({
        contexts,
        translations,
        disposed,
        afterSync() {
          translations.length = 0;
        },
      });
      try {
        board = createBoard(library, description);
      } finally {
        assembling = undefined;
      }
      return {
        board,
        operationsPerStep: size,
        initialize() {
          board.runUntil(2);
          assert.equal(board.time, 2);
          assert.equal(board.status, 'ready');
          assert.equal(contexts.length, size);
          for (const context of contexts) {
            // Evidence reactions observe changes, not the initial irqEnabled=true value.
            assert.deepEqual([...context.memory.evidence], [0, 1, 0, 0, 0, 0]);
          }
        },
        step() {
          board.topics.publish('processor/irq', null);
          steps++;
          board.runUntil(2 + steps * 16);
        },
        verify(completedSteps) {
          assert.equal(steps, completedSteps);
          assert.equal(board.time, 2 + completedSteps * 16);
          assert.equal(board.status, 'ready');
          for (const context of contexts) {
            assert.deepEqual(
              [...context.memory.evidence],
              [completedSteps % 256, 1, 1, 0, 1, 0],
              'Each CPU must handle one IRQ and return to WAIT with interrupts enabled',
            );
          }
        },
        dispose: disposeOnce(board),
      };
    },
  };
}

export async function prepareDigital(name, tools) {
  assert.ok(Number.isSafeInteger(tools.size) && tools.size > 0, 'size must be a positive integer');
  if (name === 'uart') return prepareUart(tools);
  if (name === 'cpu-irq') return prepareCpu(tools);
  throw new RangeError(`Unknown digital workload: ${name}`);
}
