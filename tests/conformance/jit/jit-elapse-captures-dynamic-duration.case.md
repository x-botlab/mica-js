---
format: mica-case/v1
id: jit-elapse-captures-dynamic-duration
kind: comparison
---

# jit-elapse-captures-dynamic-duration

## 规范来源

[docs/spec/jit/execution.rst](../../../docs/spec/jit/execution.rst)

<!-- prettier-ignore -->
> ``elapse(duration)`` 表达一个不可由普通边界条件提前截断的耗时阶段。duration 接受常量或动态值，在执行到该操作时捕获并校验；阶段开始后的资源变化不修改已捕获时长。

## 验收义务

前提：模型过程在 JIT 之前把 memory 中的时长写成 4，1 ps 后改成 1；指令以该 memory 内容作 elapse 输入，阶段结束后输出 7。

操作：先推进到 2 ps，再推进到 5 ps。

预期：2 ps 时没有任何输出；指令在 4 ps 完成已捕获的耗时后输出 7，阶段开始后的资源修改不缩短时长。

## 对照输入

```json
{
  "model": "device Probe {\n public memory code[2]; state pc: number = 0;\n output channel out: number(capacity:32);\n fn emit(value:number) { out.send(value); }\npublic memory duration[1];\n process start { store8(duration,0,4); await ticks(1); store8(duration,0,1); }\n}",
  "description": {
    "instances": [
      {
        "id": "jit",
        "type": "jit"
      }
    ],
    "nets": []
  }
}
```

## 执行步骤

```typescript
const { setup, values } = await importModule('./fixture.mjs');
const translations = [];
const { board, context, batches } = await setup(
  adapter,
  await adapter.compileDDL(inputs.model),
  (ctx) => {
    ctx.attachJit({
      entry: 'cpu',
      code: 'code',
      pc: 'pc',
      translate(input, builder) {
        builder.instruction({ pc: input.pc, nextPc: input.pc + 1 }, (body) => {
          body.elapse(body.load8('duration', 0));
          body.call('emit', 7);
          body.stop();
        });
        return builder.finish();
      },
    });
  },
  inputs.description,
);
t.after(board.dispose.bind(board));
board.runUntil(2);
assert.deepEqual(values(batches), []);
board.runUntil(5);
```

## 断言

```typescript
assert.deepEqual(values(batches), [7]);
assert.equal(batches.at(-1).outputs.out[0].time, 4);
```
