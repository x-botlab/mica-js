---
kind: comparison
---

# consistency-rununtil-slice-equivalence

## 规范来源

[docs/spec/conformance.rst](../../../docs/spec/conformance.rst)

<!-- prettier-ignore -->
> 对内部纯执行路径改变推进切片时，已发生行为应遵守恢复和终点规则；涉及外部反馈的路径还受批次边界影响。切片改变输入注入或未读清理时，不能要求两次运行无条件相同。

[docs/spec/execution/scheduling.rst](../../../docs/spec/execution/scheduling.rst)

<!-- prettier-ignore -->
> 在 ``T``，运行时 MUST NOT 开始新的 JIT 指令、调用 JIT 边界处理函数，或恢复 JIT 指令的后续代码。

[docs/spec/execution/scheduling.rst](../../../docs/spec/execution/scheduling.rst)

<!-- prettier-ignore -->
> 条件等待在 ``T`` 满足时可以记录就绪状态，其后 JIT 代码同样延后。再次调用 ``runUntil(T)`` 不解除这一终点限制。

## 验收义务

前提：同一模型含一条 JIT 指令（发送 10、elapse 4 ps、发送 11、stop）与两个普通过程（2 ps 发送 99，4 ps 把 data[0] 写为 1）。同一库分别建立两块板：一块以 1→4→5 ps 推进，另一块以 1→2→4→4→5 ps 推进。

操作：按上述切片推进两块真实板，逐项记录输出值与时间，并读取最终公开 memory。

预期：两种切片输出序列相同，均为 10@0、99@2、11@4；4 ps 处只完成普通事件，JIT 后缀留到下一次目标更大的推进，重复 runUntil(4) 不改变结果；最终 data 都是 [1,0]。

## 对照输入

```json
{
  "model": "device Slice {\n  public memory data[1];\n  public memory code[1];\n  state pc: number = 0;\n  output channel out: number(capacity: 32);\n  fn emit(value: number) { out.send(value); }\n  process start {\n    await ticks(2);\n    out.send(99);\n  }\n  process second {\n    await ticks(4);\n    store8(data, 0, 1);\n  }\n}",
  "description": {
    "instances": [
      {
        "id": "one",
        "type": "jit"
      }
    ],
    "nets": []
  }
}
```

## 执行步骤

```typescript
const model = await adapter.compileDDL(inputs.model);
const contexts = [];
let sink = [];
const library = adapter.createDeviceLibrary([
  {
    id: 'jit',
    model,
    create(ctx) {
      contexts.push(ctx);
      ctx.attachJit({
        entry: 'cpu',
        code: 'code',
        pc: 'pc',
        translate(position, builder) {
          builder.instruction({ pc: position.pc, nextPc: position.pc + 1 }, (body) => {
            body.call('emit', 10);
            body.elapse(4);
            body.call('emit', 11);
            body.stop();
          });
          return builder.finish();
        },
      });
      ctx.loadBytes('code', new Uint8Array([0]));
      return {
        sync(batch) {
          if (batch.outputs.out)
            sink.push(
              ...batch.outputs.out.map((message) => ({ value: message.value, time: message.time })),
            );
        },
        dispose() {},
      };
    },
  },
]);
const describe = () => ({ instances: [{ id: 'one', type: 'jit' }], nets: [] });
const oneShot = adapter.createBoard(library, describe());
t.after(oneShot.dispose.bind(oneShot));
oneShot.runUntil(1);
oneShot.runUntil(4);
oneShot.runUntil(5);
const expected = sink.slice();
sink = [];
const sliced = adapter.createBoard(library, describe());
t.after(sliced.dispose.bind(sliced));
sliced.runUntil(1);
sliced.runUntil(2);
sliced.runUntil(4);
sliced.runUntil(4);
sliced.runUntil(5);
const actual = sink.slice();
```

## 断言

```typescript
assert.deepEqual(expected, [
  { value: 10, time: 0 },
  { value: 99, time: 2 },
  { value: 11, time: 4 },
]);
assert.deepEqual(actual, expected);
assert.deepEqual([...contexts[0].memory.data], [1, 0]);
assert.deepEqual([...contexts[1].memory.data], [1, 0]);
```
