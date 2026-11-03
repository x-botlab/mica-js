---
format: mica-case/v1
id: language-atomic-numeric-bases
kind: simulation
---

# numeric-bases

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 支持十进制整数、小数、科学计数法以及 ``0x``、``0b``、``0o`` 前缀的整数字面量。小数点两侧都要有数字，例如 ``0.5`` 与 ``1.0``；``.5`` 与 ``1.`` 不是合法字面量。指数部分可以有正负号。前缀大小写均可使用。

## 验收义务

前提：启动过程发送十六、二进制、八进制整数字面量。

操作：建立真实板，运行到时间 0，收集 `out` 通道的公开输出。

预期：运行到时间 0 后，`out` 通道依次收到 255、10 与 15。

## 模型

<!-- prettier-ignore -->
```ddl
device Atomic {
output channel out: number(capacity: 32);

process start {
out.send(0Xff); out.send(0B1010); out.send(0O17);
}
}
```

## 装配

```json
{
  "instances": [
    {
      "id": "atomic",
      "type": "language/atomic"
    }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const batches = [];
const model = await adapter.compileDDL(modelSource);
const library = adapter.createDeviceLibrary([
  {
    id: 'language/atomic',
    model,
    create() {
      return {
        sync(batch) {
          batches.push(batch);
        },
        dispose() {},
      };
    },
  },
]);
const board = adapter.createBoard(library, description);
t.after(() => board.dispose());
board.runUntil(0);
const actual = batches.flatMap((batch) => batch.outputs.out.map((message) => message.value));
```

## 断言

```typescript
assert.deepEqual(actual, [255, 10, 15]);
```
