---
kind: comparison
---

# jit-code-regions-logical-pc

## 规范来源

[动态执行入口](../../../docs/spec/jit/index.rst)

[代码存储与失效](../../../docs/spec/jit/code-memory.rst)

## 验收义务

前提：一个 JIT 绑定主 `code` 内存，并追加 Flash alias、SRAM 两个 region；SRAM 是 private memory。

操作：分别从 `0x00000000`、`0x08000000` 和 `0x20000000` 翻译并执行；在工厂内尝试装载 SRAM 和非代码 memory；翻译回调保存本次代码视图。

预期：logical PC 不归一化；Flash alias 与主区域读到同一 `code` 内存但报告不同 `codeBase`；SRAM 从 `sram` 读到自己的字节；代码视图只在回调期间有效；只有声明为 code region 的 memory 允许 `loadBytes`。

## 对照输入

```json
{
  "model": "device RegionProbe(startPc: number default 0) {\n  public memory flash[8];\n  memory sram[8];\n  memory ccm[8];\n  memory other[8];\n  state pc: number = 0;\n  output channel out: number(capacity: 16);\n  fn emit(value: number) { out.send(value); }\n  process start { pc = startPc; }\n}",
  "description": { "instances": [{ "id": "jit", "type": "jit" }], "nets": [] }
}
```

## 执行步骤

```typescript
const { setup } = await importModule('./fixture.mjs');
const model = await adapter.compileDDL(inputs.model);
const FLASH_ALIAS = 0x08000000;
const SRAM = 0x20000000;
const CCM = 0x10000000;

async function run(startPc, flashByte, sramByte, ccmByte) {
  const translations = [];
  let borrowed;
  let borrowedLength = 0;
  let denied = false;
  const { board, batches } = await setup(
    adapter,
    model,
    (ctx) => {
      const registration = ctx.attachJit({
        entry: 'cpu',
        code: 'flash',
        codeRegions: [
          { memory: 'flash', base: FLASH_ALIAS, size: 8 },
          { memory: 'sram', base: SRAM, size: 8 },
          { memory: 'ccm', base: CCM, size: 8 },
        ],
        pc: 'pc',
        translate(input, builder) {
          borrowed = input.code;
          borrowedLength = input.code.length;
          const byte = input.code[input.pc - input.codeBase];
          translations.push({
            pc: input.pc,
            base: input.codeBase,
            version: input.codeVersion,
            byte,
            length: input.code.length,
          });
          builder.instruction({ pc: input.pc, nextPc: input.pc }, (body) => {
            body.call('emit', byte);
            body.stop();
          });
          return builder.finish();
        },
      });
      try {
        ctx.loadBytes('flash', Uint8Array.of(flashByte));
        ctx.loadBytes('sram', Uint8Array.of(sramByte));
        ctx.loadBytes('ccm', Uint8Array.of(ccmByte));
        try {
          ctx.loadBytes('other', Uint8Array.of(9));
        } catch {
          denied = true;
        }
      } catch (cause) {
        registration.dispose();
        throw cause;
      }
      return { sync() {}, dispose: () => registration.dispose() };
    },
    {
      ...inputs.description,
      instances: [{ id: 'jit', type: 'jit', props: { startPc } }],
    },
  );
  board.runUntil(1);
  const output = batches.flatMap((batch) => batch.outputs.out.map((message) => message.value));
  assert.throws(() => borrowed[0], /Translation view expired/);
  board.dispose();
  return { translations, output, borrowedLength, denied };
}

const primary = await run(0, 0x2a, 0x33, 0x44);
const alias = await run(FLASH_ALIAS, 0x2a, 0x33, 0x44);
const sram = await run(SRAM, 0x2a, 0x33, 0x44);
const ccm = await run(CCM, 0x2a, 0x33, 0x44);
```

## 断言

```typescript
assert.deepEqual(primary.translations[0], { pc: 0, base: 0, version: primary.translations[0].version, byte: 0x2a, length: 8 });
assert.deepEqual(alias.translations[0], { pc: FLASH_ALIAS, base: FLASH_ALIAS, version: alias.translations[0].version, byte: 0x2a, length: 8 });
assert.deepEqual(sram.translations[0], { pc: SRAM, base: SRAM, version: sram.translations[0].version, byte: 0x33, length: 8 });
assert.deepEqual(ccm.translations[0], { pc: CCM, base: CCM, version: ccm.translations[0].version, byte: 0x44, length: 8 });
assert.ok(primary.translations[0].version >= 1);
assert.ok(alias.translations[0].version >= 1);
assert.ok(sram.translations[0].version >= 1);
assert.ok(ccm.translations[0].version >= 1);
assert.deepEqual(primary.output, [0x2a]);
assert.deepEqual(alias.output, [0x2a]);
assert.deepEqual(sram.output, [0x33]);
assert.deepEqual(ccm.output, [0x44]);
assert.equal(primary.borrowedLength, 8);
assert.equal(alias.borrowedLength, 8);
assert.equal(sram.borrowedLength, 8);
assert.equal(ccm.borrowedLength, 8);
assert.equal(primary.denied, true);
assert.equal(alias.denied, true);
assert.equal(sram.denied, true);
assert.equal(ccm.denied, true);
```

Note: the execution block keeps `borrowed` only to observe the post-callback lifetime; it is never read for translation or execution.
