---
format: mica-case/v1
id: jit-identical-nonempty-load-invalidates
kind: comparison
---

# jit-identical-nonempty-load-invalidates

## 规范来源

[docs/spec/jit/code-memory.rst](../../../docs/spec/jit/code-memory.rst)

<!-- prettier-ignore -->
> 合法非空代码写入即使字节相同也产生失效；非空成功装载还结束同一存储的借用内容稳定期。

## 验收义务

前提：单指令循环回到同一位置；暂停期间向代码存储写入与当前内容相同的非空字节。

操作：越过当前指令边界继续推进。

预期：输出两次 7，同一位置必须重新翻译一次。

## 对照输入

```json
{
  "model": "device Probe {\n public memory code[2]; state pc: number = 0;\n output channel out: number(capacity:32);\n fn emit(value:number) { out.send(value); }\n\n}",
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
        translations.push(input.pc);
        builder.instruction({ pc: 0, nextPc: 0 }, (body) => {
          body.call('emit', 7);
          body.elapse(2);
        });
        return builder.finish();
      },
    });
    ctx.loadBytes('code', new Uint8Array([3]));
  },
  inputs.description,
);
t.after(board.dispose.bind(board));
board.runUntil(1);
assert.deepEqual(values(batches), [7]);
context.loadBytes('code', new Uint8Array([3]));
board.runUntil(3);
```

## 断言

```typescript
assert.deepEqual(values(batches), [7, 7]);
assert.deepEqual(translations, [0, 0]);
```
