---
kind: comparison
---

# jit-code-region-stack-write-cache

## 规范来源

[代码存储与失效](../../../docs/spec/jit/code-memory.rst)

[动态执行入口](../../../docs/spec/jit/index.rst)

## 验收义务

前提：Flash 主代码 region 已翻译并在执行，SRAM 作为追加的 code region 声明，但当前指令只把 SRAM 当普通栈/数据写入。

操作：在同一个热循环中反复写 SRAM，推进一段时间后统计 Flash PC 的翻译次数。

预期：SRAM 普通栈/数据写可以递增 SRAM 版本并失效 SRAM 自己的块，但不得清除已翻译的 Flash 块；Flash 主代码在预热后不再重复翻译。直接后端的 `direct` 计数由 simulator 包内的定向测试验证，本 conformance case 只断言公开的翻译次数。

## 对照输入

```json
{
  "model": "device StackProbe {\n  public memory flash[4];\n  memory sram[4];\n  state pc: number = 0;\n  state tick: number = 0;\n}",
  "description": { "instances": [{ "id": "jit", "type": "jit" }], "nets": [] }
}
```

## 执行步骤

```typescript
const { setup } = await importModule('./fixture.mjs');
const model = await adapter.compileDDL(inputs.model);
const translations = [];
const { board } = await setup(
  adapter,
  model,
  (ctx) => {
    ctx.attachJit({
      entry: 'cpu',
      code: 'flash',
      codeRegions: [{ memory: 'sram', base: 0x20000000, size: 4 }],
      pc: 'pc',
      translate(input, builder) {
        translations.push(input.pc);
        builder.instruction({ pc: 0, nextPc: 0 }, (body) => {
          body.store8('sram', 0, 1);
          body.elapse(1);
        });
        return builder.finish();
      },
    });
    ctx.loadBytes('flash', new Uint8Array([1, 1, 1, 1]));
    return { sync() {}, dispose() {} };
  },
  inputs.description,
);
board.runUntil(50);
board.dispose();
```

## 断言

```typescript
assert.deepEqual(translations, [0]);
```
