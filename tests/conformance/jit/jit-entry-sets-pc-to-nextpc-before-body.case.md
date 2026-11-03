---
kind: comparison
---

# jit-entry-sets-pc-to-nextpc-before-body

## 规范来源

[docs/spec/jit/execution.rst](../../../docs/spec/jit/execution.rst)

<!-- prettier-ignore -->
> 开始指令时，运行时保存该分组的位置与后继信息，先将绑定 state 设为 ``nextPc``，再按顺序执行指令体。
>
> 因此，正常语义函数读取的位置默认是顺序后继；需要原始指令位置时，生成者将 ``pc`` 作为普通常量传给函数。

## 验收义务

前提：首条指令分组为 pc 0、nextPc 5，指令体调用模型函数 report 读取绑定 state pc 并发送；位置 5 的指令发送 7 后停止。

操作：推进真实板一次，记录翻译位置。

预期：首次发送值为 5 而非 0；第二条指令从 5 处翻译并执行，发送 7。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[2];\n  state pc: number = 0;\n  output channel out: number(capacity: 32);\n  fn report() { out.send(pc); }\n  fn emit(value: number) { out.send(value); }\n}",
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
const { board, batches } = await setup(
  adapter,
  await adapter.compileDDL(inputs.model),
  (ctx) => {
    ctx.attachJit({
      entry: 'cpu',
      code: 'code',
      pc: 'pc',
      translate(input, builder) {
        translations.push(input.pc);
        if (input.pc === 0)
          builder.instruction({ pc: 0, nextPc: 5 }, (body) => body.call('report'));
        else
          builder.instruction({ pc: 5, nextPc: 6 }, (body) => {
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
board.runUntil(1);
```

## 断言

```typescript
assert.deepEqual(values(batches), [5, 7]);
assert.deepEqual(translations, [0, 5]);
```
