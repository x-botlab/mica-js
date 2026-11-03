---
kind: simulation
---

# 输入字节只复制所选视图

## 规范来源

[docs/spec/channels.rst](../../../../docs/spec/channels.rst)

<!-- prettier-ignore -->
> 输入 ``send`` 接受 ``Uint8Array``，在调用时复制该视图的 ``byteOffset`` 与 ``byteLength`` 所选范围。调用成功返回后，修改源视图、父数组或记录对象不影响已接纳消息。

## 验收义务

前提：输入字节通道的 `capacity` 为 1、`maxLength` 为 2；调用方发送父数组 [9, 1, 2, 9] 的中间两字节子视图，发送成功后把父数组全部改写为 7。

操作：通过真实 adapter 编译模型，注入该子视图并推进到 0；模型把收到的值转发到输出通道。

预期：模型只收到 [1, 2]；父数组的后续修改不进入已接纳消息。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  input channel incoming: bytes(maxLength: 2, capacity: 1);
  output channel out: bytes(maxLength: 2, capacity: 1);
  process start {
    let value = await incoming.receive();
    out.send(value);
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
t.after(() => board.dispose());
const parent = new Uint8Array([9, 1, 2, 9]);
context.inputs.incoming.send(parent.subarray(1, 3));
parent.fill(7);
board.runUntil(0);
```

## 断言

```typescript
assert.deepEqual(
  values(batches).map((v) => [...v]),
  [[1, 2]],
);
```
