---
kind: comparison
---

# UART 电气收帧驱动处理器中断

## 规范来源

[电气](../../../docs/spec/electrical.rst)、[批次](../../../docs/spec/channels.rst)、[中断与等待](../../../docs/spec/jit/interrupts.rst)、[指令恢复](../../../docs/spec/jit/execution.rst)。

## 验收义务

三器件链路使用两个真实 UART 和真实处理器：sender TX 经电阻支路连接 receiver RX，receiver 在 95ps 收到字节，在截至 100ps 的 sync 发布 processor/irq。同板通知必须进入下一批；CPU 此前停在 WAIT，收到中断后保存顺序 PC=1、以 2ps 延迟跳转 128、运行 LDI 9/IRET，再返回 ACK/LDI 7/HALT。两次运行保留相同的 100ps 外部交付边界，分别一次推进和切片推进，比较独立结果，不假定不同外部交付时刻仍等价。

## 对照输入

```json
{"byte": 85, "afterDelivery": [[112], [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 112]]}
```

## 执行步骤

```typescript
const { fixture, endpoint, net, rails } = await importModule('./support.mjs');
const { createUart } = await importModule('./uart/uart-adapter.js');
const { observedProcessor, processorFactory, processorCases } = await importModule('./processor-support.mjs');
const uartModel = await fixture(adapter, 'uart');
const cpuModel = observedProcessor(adapter);
const runs = [];
for (const targets of inputs.afterDelivery) {
  const contexts = [], translations = [], disposed = [];
  const uartContexts = [], frames = [], irqDeliveries = [], uartDisposed = [];
  const library = adapter.createDeviceLibrary([
    { id: 'processor', model: cpuModel,
      create: processorFactory({ contexts, translations, disposed }) },
    { id: 'uart', model: uartModel,
      create(ctx) {
        const index = uartContexts.length;
        uartContexts.push(ctx);
        const paired = createUart(ctx);
        return {
          sync(batch) {
            paired.sync(batch);
            if (index === 1) {
              for (const message of batch.outputs.received) {
                frames.push(message);
                irqDeliveries.push(batch.to);
                ctx.topics.publish('processor/irq', message.value);
              }
            }
          },
          dispose() { uartDisposed.push(index); paired.dispose(); },
        };
      },
    },
  ]);
  const firmware = new Uint8Array(256);
  firmware.set(processorCases.waitAndIrq);
  firmware.set(processorCases.irqHandler, 128);
  const board = adapter.createBoard(library, {
    instances: [
      { id: 'cpu', type: 'processor', props: { firmware } },
      { id: 'sender', type: 'uart', props: { bitTime: 10 } },
      { id: 'receiver', type: 'uart', props: { bitTime: 10 } },
    ],
    nets: [...rails(['sender', 'receiver']),
      net('serial', [endpoint('sender', 'tx'), endpoint('receiver', 'rx')]),
      net('return', [endpoint('receiver', 'tx'), endpoint('sender', 'rx')])],
  });
  t.after(() => board.dispose());
  uartContexts[0].inputs.transmit.send(new Uint8Array([inputs.byte]));
  board.runUntil(100);
  const evidence = contexts[0].memory.evidence;
  assert.equal(evidence[0], 0);
  assert.equal(evidence[1], 1);
  assert.equal(evidence[3], 0, 'sync-staged IRQ must not execute in the delivered batch');
  assert.deepEqual(translations.map(({ pc }) => pc), [0]);
  for (const target of targets) {
    board.runUntil(target);
    assert.equal(board.time, target);
    assert.equal(board.status, 'ready');
    if (target === 100) {
      assert.equal(evidence[3], 1);
      assert.deepEqual(translations.map(({ pc }) => pc), [0]);
    }
    if (target === 103) assert.equal(evidence[0], 9);
    if (target === 107) assert.equal(evidence[0], 9);
    if (target === 108) assert.equal(evidence[0], 7);
  }
  runs.push({ board, evidence, translations, disposed, uartDisposed, frames, irqDeliveries });
}
```

## 断言

```typescript
for (const run of runs) {
  assert.deepEqual(run.frames, [{ time: 95,
    value: { value: inputs.byte, framingError: false, unknown: false } }]);
  assert.deepEqual(run.irqDeliveries, [100]);
  assert.deepEqual([...run.evidence], [7, 5, 1, 0, 1, 0]);
  assert.deepEqual(run.translations.map(({ pc }) => pc), [0, 128, 1, 4]);
}
assert.deepEqual([...runs[0].evidence], [...runs[1].evidence]);
for (const run of runs) {
  run.board.dispose();
  run.board.dispose();
  assert.equal(run.disposed.length, 1);
  assert.deepEqual(run.uartDisposed, [1, 0]);
  assert.equal(run.board.status, 'disposed');
}
```
