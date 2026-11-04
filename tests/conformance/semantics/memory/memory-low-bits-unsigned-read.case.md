---
kind: simulation
---

# 写入取低位且读取为无符号数

## 规范来源

[docs/spec/memory.rst](../../../../docs/spec/memory.rst)

<!-- prettier-ignore -->
> 写入值 MUST 是安全整数。操作取相应宽度的低位作为写入内容，负值采用相同转换。

<!-- prettier-ignore -->
> 读取结果统一为无符号 ``number``；其他数值解释由模型函数完成。

## 验收义务

前提：8 字节公开存储；`store8` 写入 256，偏移 1 以 `store16le` 写入 4660，偏移 4 以 `store32be` 写入 -1。

操作：通过真实 adapter 编译模型并推进到 0；模型分别用 `load8`、`load16be`、`load32be` 读回并输出，随后读取公开存储全部字节。

预期：公开字节为 [0, 52, 18, 255, 255, 255, 255, 255]；读回依次为 0、13330、4294967295，端序按操作名解释，32 位读取仍是 `number`。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  public memory data[8];
  process start {
    store8(data, 0, 256);
    store16le(data, 1, 4660);
    store32be(data, 4, -1);
    out.send(load8(data, 0));
    out.send(load16be(data, 1));
    out.send(load32be(data, 4));
  }
}
```

## 装配

```json
{
  "instances": [
    {
      "id": "probe",
      "type": "probe"
    }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const { device, values } = await importModule('../fixture.mjs');
const { board, context, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(board.dispose.bind(board));

board.runUntil(0);
```

## 断言

```typescript
assert.deepEqual(values(batches), [0, 13330, 4294967295]);
assert.deepEqual([...context.memory.data], [0, 52, 18, 0, 255, 255, 255, 255]);
assert.equal(board.status, 'ready');
```
