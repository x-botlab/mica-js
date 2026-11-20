---
kind: comparison
---

# jit-code-metadata-wfi-patch

## 规范来源

[吞吐执行与轮询等待](../../../docs/spec/jit/throughput.rst)

[代码存储与失效](../../../docs/spec/jit/code-memory.rst)

## 验收义务

前提：`codeMetadata` provider 按 region/codeVersion 提供 WFI polling；代码在运行中被同字节重写或被替换为普通指令。

操作：单次 `runUntil(10)` 内等待 provider 刷新 metadata，再执行/唤醒。

预期：同字节 WFI 重写仍要经过 `wait.advance` 才能唤醒；替换为普通 opcode 后不再旧 park；provider 首次收到整区 changes，后续同字节写入也触发重新确认。

## 对照输入

```json
{
  "model": "device MetadataWfi(nextByte: number default 1) {\n  public memory code[4];\n  state pc: number = 0;\n  state awake: bool = false;\n  output channel out: number(capacity: 8);\n  pure fn awakeNow(): bool { return awake; }\n  pure fn waitPs(): number { return 3; }\n  fn advance(elapsed: number) { awake = true; }\n  process start {\n    await ticks(1);\n    store8(code, 0, nextByte);\n  }\n}",
  "description": { "instances": [{ "id": "jit", "type": "jit" }], "nets": [] }
}
```

## 执行步骤

```typescript
const { setup } = await importModule('./fixture.mjs');
const model = await adapter.compileDDL(inputs.model);

async function run(nextByte) {
  const calls = [];
  const translations = [];
  const output = [];
  const { board, batches } = await setup(
    adapter,
    model,
    (ctx) => {
      ctx.attachJit({
        entry: 'cpu',
        code: 'code',
        codeMetadata(input) {
          calls.push({
            changes: input.changes.map((change) => [change.offset, change.length]),
          });
          return {
            polling:
              input.region.code[0] === 1
                ? [{
                    pc: 0,
                    predicate: 'awakeNow',
                    wait: { delay: 'waitPs', advance: 'advance' },
                  }]
                : [],
            delays: new Map(),
          };
        },
        pc: 'pc',
        translate(input, builder) {
          const byte = input.code[0];
          translations.push(byte);
          builder.instruction({ pc: 0, nextPc: 1 }, (body) => {
            body.send('out', byte);
            body.stop();
          });
          return builder.finish();
        },
      });
      ctx.loadBytes('code', new Uint8Array([1, 1, 1, 1]));
      return { sync() {}, dispose() {} };
    },
    {
      ...inputs.description,
      instances: [{ id: 'jit', type: 'jit', props: { nextByte } }],
    },
  );
  board.runUntil(10);
  const messages = batches.flatMap((batch) => batch.outputs.out);
  board.dispose();
  return { calls, translations, messages };
}

const sameByte = await run(1);
const replaced = await run(2);
```

## 断言

```typescript
assert.deepEqual(sameByte.messages.map((message) => message.value), [1]);
assert.ok(sameByte.messages[0].time >= 4);
assert.equal(sameByte.translations[0], 1);
assert.ok(sameByte.calls.length > 1);
assert.deepEqual(sameByte.calls[0].changes, [[0, 4]]);
assert.ok(sameByte.calls.some((call) => JSON.stringify(call.changes) === '[[0,1]]'));
assert.deepEqual(replaced.messages.map((message) => message.value), [2]);
assert.equal(replaced.messages[0].time, 1);
assert.equal(replaced.translations[0], 2);
assert.ok(replaced.calls.length > 1);
```
