---
kind: simulation
---

# string-escapes

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 字符串使用双引号，支持 ``\"``、``\\``、``\n``、``\r``、``\t``、``\uXXXX`` 和 ``\u{...}`` 转义。``\uXXXX`` 表示一个 UTF-16 代码单元；码点形式的数值范围为 0 至 0x10ffff。非法转义与未转义换行在编译时拒绝。

## 验收义务

前提：输入包含引号、反斜线、控制字符、四位 Unicode 与码点形式转义。

操作：建立真实板，运行到时间 0，收集 `out` 通道的公开输出。

预期：运行到时间 0 后，`out` 通道依次收到 5、3 与 1。

## 模型

<!-- prettier-ignore -->
```ddl
device Atomic {
output channel out: number(capacity: 32);

process start {
out.send("\"\\\n\r\t".length); out.send("\u0041\u{1f600}".length); out.send("\u0041" == "A" ? 1 : 0);
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
assert.deepEqual(actual, [5, 3, 1]);
```
