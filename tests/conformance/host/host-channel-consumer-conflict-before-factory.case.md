---
kind: simulation
---

# 跨过程接收同一通道在工厂前拒绝

## 规范来源

[docs/spec/channels.rst](../../../docs/spec/channels.rst)

<!-- prettier-ignore -->
> 输入 FIFO 的单消费者按静态过程中的 ``receive`` 位置判定：同一过程可有多个接收位置；两个不同过程接收同一通道时 MUST 拒绝，即使其分支看似互斥，也不进行互斥证明。通道可以无人消费。此项检查在调用任何器件工厂前完成。

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 库登记的 model 不满足共享 IR schema、类型、作用域或效果合同；其 BuildError 保留在 diagnostic.cause，专用通道消费者冲突使用 CHANNEL_CONSUMER_CONFLICT。

<!-- prettier-ignore -->
> CHANNEL_CONSUMER_CONFLICT | 不同过程可能消费同一个 input channel。

<!-- prettier-ignore -->
> 独立 IR 校验器仍按 D2 直接抛 BuildError。

[docs/spec/ir/validation.rst](../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> 构造、完成及绑定校验失败抛出 ``BuildError``，包含至少一条 Diagnostic。

[docs/spec/conformance.rst](../../../docs/spec/conformance.rst)

<!-- prettier-ignore -->
> 定义在参与装配或执行前被拒绝。

## 验收义务

前提：先装配一个同特性合法模型——同一过程有两个 `receive` 位置并输出两值之和；再构造冲突模型，两个由同一通知触发的过程各自 `receive` 同一个输入通道，工厂记录调用次数。

操作：先运行合法模型；再依次尝试编译冲突模型、登记器件库、创建板，记录第一个拒绝发生的阶段与错误。

预期：单过程多次接收合法，板输出 [3] 且工厂被调用一次。冲突模型是有效 DDL，但单消费者检查必须在调用任何器件工厂前拒绝它；规范没有把该检查固定在某一入口，因此三个入口中最早发生者即判定。若编译器在定义检查阶段拒绝，错误须为包含非空 `diagnostics` 的 `BuildError`；若由库或板入口拒绝，须为带 `CHANNEL_CONSUMER_CONFLICT` 的 `SimulationError`。其他异常形态或全部入口均不拒绝都判失败，冲突工厂调用次数为零。

## 模型

<!-- prettier-ignore -->
```ddl
device HostProbe {
  input channel incoming: number(capacity: 2);
  input notification wake;
  process takeFirst on wake {
    let value = await incoming.receive();
  }
  process takeSecond on wake {
    let value = await incoming.receive();
  }
}
```

## 装配

```json
{
  "instances": [
    {
      "id": "probe",
      "type": "probe"
    }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const single = await adapter.compileDDL(
  `device SingleConsumer {
  input channel incoming: number(capacity: 2);
  output channel out: number(capacity: 2);
  process start {
    let first = await incoming.receive();
    let second = await incoming.receive();
    out.send(first + second);
  }
}`,
);
let singleCalls = 0;
const delivered = [];
const singleLibrary = adapter.createDeviceLibrary([
  {
    id: 'single',
    model: single,
    create(ctx) {
      singleCalls++;
      ctx.inputs.incoming.send(1);
      ctx.inputs.incoming.send(2);
      return {
        sync(batch) {
          delivered.push(...batch.outputs.out.map((message) => message.value));
        },
        dispose() {},
      };
    },
  },
]);
const legal = adapter.createBoard(singleLibrary, {
  instances: [{ id: 'single', type: 'single' }],
  nets: [],
});
t.after(legal.dispose.bind(legal));
legal.runUntil(0);

let calls = 0;
let rejectedAt = null;
let rejection;
let library;
try {
  const conflictModel = await adapter.compileDDL(modelSource);
  try {
    library = adapter.createDeviceLibrary([
      {
        id: 'probe',
        model: conflictModel,
        create() {
          calls++;
          return { sync() {}, dispose() {} };
        },
      },
    ]);
  } catch (error) {
    rejectedAt = 'library';
    rejection = error;
  }
} catch (error) {
  rejectedAt = 'compile';
  rejection = error;
}
if (rejectedAt === null) {
  try {
    adapter.createBoard(library, description);
  } catch (error) {
    rejectedAt = 'assembly';
    rejection = error;
  }
}
```

## 断言

```typescript
assert.equal(singleCalls, 1);
assert.deepEqual(delivered, [3]);
assert.equal(legal.status, 'ready');

assert.ok(rejectedAt !== null, 'the consumer conflict must be rejected before any factory call');
assert.equal(calls, 0);
if (rejectedAt === 'compile') {
  assert.ok(rejection instanceof Error);
  assert.ok(Array.isArray(rejection.diagnostics));
  assert.ok(rejection.diagnostics.length > 0);
  assert.equal(typeof rejection.diagnostics[0].code, 'string');
  assert.equal(typeof rejection.diagnostics[0].message, 'string');
} else {
  assert.equal(rejection.code, 'CHANNEL_CONSUMER_CONFLICT');
  assert.equal(rejection.diagnostic.code, 'CHANNEL_CONSUMER_CONFLICT');
}
```
