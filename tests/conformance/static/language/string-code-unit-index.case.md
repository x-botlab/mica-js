---
kind: simulation
---

# string-code-unit-index

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> ``string`` 是不可变 UTF-16 代码单元序列。字符串之间可以拼接和比较相等，不与 number 等其他类型隐式转换。``value.length`` 返回代码单元数量；``value[index]`` 返回一个代码单元构成的 string。它不按字素或 Unicode 码点索引。

## 验收义务

前提：字符串以码点转义 `\u{1f600}` 构造，其 UTF-16 表示为代理对。

操作：建立真实板，运行到时间 0，收集 `out` 通道的公开输出。

预期：运行到时间 0 后，`out` 通道依次收到 2、1 与 1：长度为代码单元数量，索引 0、1 分别给出代理对的单个代码单元。

## 模型

```ddl
device Atomic {
output channel out: number(capacity: 8);
process start {
const face = "\u{1f600}";
out.send(face.length);
out.send(face[0] == "\ud83d" ? 1 : 0);
out.send(face[1] == "\ude00" ? 1 : 0);
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
const { runDDLOutput } = await importModule('../assertions.mjs');
assert.deepEqual(description, {
  instances: [{ id: 'atomic', type: 'language/atomic' }],
  nets: [],
});
const actual = await runDDLOutput(adapter, t, modelSource);
```

## 断言

```typescript
assert.deepEqual(actual, [2, 1, 1]);
```
