---
format: mica-case/v1
id: jit-stop-keeps-load-rights-but-last-binding-release-revokes-them
kind: comparison
---

# jit-stop-keeps-load-rights-but-last-binding-release-revokes-them

## 规范来源

[docs/spec/jit/code-memory.rst](../../../docs/spec/jit/code-memory.rst)

[docs/spec/jit/execution.rst](../../../docs/spec/jit/execution.rst)

## 验收义务

前提：JIT 入口已 stop，随后装载新代码并释放最后绑定。

操作：stop 后检查装载与借用，再释放最后注册并尝试再次装载。

预期：stop 后装载不重启；公开借用立即看到新内容，旧副本不变；最后绑定释放后装载被拒绝。

## 对照输入

```json
{
  "models": {
    "jitProbe": "device JitProbe {\n    public memory code[2]; state pc: number = 0;\n    output channel out: number(capacity: 32);\n    fn emit(value: number) { out.send(value); }\n    \n  }"
  },
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

let registration;
const { board, context, batches } = await setup(
  adapter,
  await adapter.compileDDL(inputs.models.jitProbe),
  (ctx) => {
    registration = ctx.attachJit({
      entry: 'cpu',
      code: 'code',
      pc: 'pc',
      translate(input, builder) {
        const byte = input.code[0];
        builder.instruction({ pc: input.pc, nextPc: input.pc + 1 }, (body) => {
          body.call('emit', byte);
          body.stop();
        });
        return builder.finish();
      },
    });
    ctx.loadBytes('code', new Uint8Array([1]));
  },
  inputs.description,
);
t.after(board.dispose.bind(board));

board.runUntil(1);
const view = context.memory.code;
const before = view.slice();
assert.deepEqual(values(batches), [1]);
context.loadBytes('code', new Uint8Array([2]));
assert.deepEqual([...view], [2, 0]);
assert.deepEqual([...before], [1, 0]);
board.runUntil(2);
assert.deepEqual(values(batches), [1]);
registration.dispose();
```

## 断言

```typescript
assert.throws(
  () => context.loadBytes('code', new Uint8Array([3])),
  (error) => error.code === 'INVALID_BINDING',
);
assert.deepEqual([...view], [2, 0]);
assert.equal(board.status, 'ready');

board.dispose();
```
