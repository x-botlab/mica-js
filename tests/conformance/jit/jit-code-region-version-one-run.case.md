---
kind: comparison
---

# jit-code-region-version-one-run

## 规范来源

[代码存储与失效](../../../docs/spec/jit/code-memory.rst)

[动态执行入口](../../../docs/spec/jit/index.rst)

## 验收义务

前提：SRAM region 中的旧指令已翻译并在执行；一个 `start` 过程在同一 `runUntil` 内写入该 SRAM region 并保持同一 logical PC。

操作：分别用不同字节和同字节覆盖已翻译的 SRAM 指令，单次 `runUntil(3)` 内继续执行。

预期：代码写入后下一次翻译看到递增的 `codeVersion`；即使字节相同也重新翻译；输出在新代码后使用新字节；不要求 `sync` 回填。

## 对照输入

```json
{
  "model": "device VersionProbe(initialByte: number default 1, nextByte: number default 9) {\n  public memory flash[8];\n  memory sram[8];\n  state pc: number = 0x20000000;\n  output channel out: number(capacity: 64);\n  fn emit(value: number) { out.send(value); }\n  process start {\n    await ticks(1);\n    store8(sram, 0, nextByte);\n    pc = 0x20000000;\n  }\n}",
  "description": { "instances": [{ "id": "jit", "type": "jit" }], "nets": [] }
}
```

## 执行步骤

```typescript
const { setup } = await importModule('./fixture.mjs');
const model = await adapter.compileDDL(inputs.model);

async function run(initialByte, nextByte) {
  const translations = [];
  const { board, batches } = await setup(
    adapter,
    model,
    (ctx) => {
      const registration = ctx.attachJit({
        entry: 'cpu',
        code: 'flash',
        codeRegions: [{ memory: 'sram', base: 0x20000000, size: 8 }],
        pc: 'pc',
        translate(input, builder) {
          const byte = input.code[input.pc - input.codeBase];
          translations.push({ pc: input.pc, version: input.codeVersion, byte });
          builder.instruction({ pc: input.pc, nextPc: input.pc }, (body) => {
            body.call('emit', byte);
            body.elapse(1);
          });
          return builder.finish();
        },
      });
      try {
        ctx.loadBytes('sram', Uint8Array.of(initialByte));
      } catch (cause) {
        registration.dispose();
        throw cause;
      }
      return { sync() {}, dispose: () => registration.dispose() };
    },
    {
      ...inputs.description,
      instances: [{ id: 'jit', type: 'jit', props: { initialByte, nextByte } }],
    },
  );
  board.runUntil(3);
  const output = batches.flatMap((batch) => batch.outputs.out.map((message) => message.value));
  board.dispose();
  return { output, translations };
}

const changed = await run(1, 9);
const same = await run(9, 9);
```

## 断言

```typescript
assert.equal(changed.output[0], 1);
assert.ok(changed.output.includes(9));
assert.ok(changed.translations.filter((item) => item.pc === 0x20000000).length >= 2);
assert.ok(new Set(changed.translations.map((item) => item.version)).size > 1);
assert.deepEqual(same.output.every((value) => value === 9), true);
assert.ok(same.translations.filter((item) => item.pc === 0x20000000).length >= 2);
assert.ok(new Set(same.translations.map((item) => item.version)).size > 1);
```
