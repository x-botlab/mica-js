---
format: mica-case/v1
id: markdown-initial-intent-acceptance-comparison
kind: comparison
---

# 两种空意图声明的接受检查

通过一个 JSON 块组织两种声明，各自与独立预期核对。

本例只比较编译接受和引脚声明；空意图的运行行为等价性需要另写仿真用例。

## 规范来源

[docs/spec/language/declarations.rst](../../../docs/spec/language/declarations.rst)

[docs/spec/electrical.rst](../../../docs/spec/electrical.rst)

## 验收义务

前提：两个输入分别省略 pin 初值和显式写 `= []`。

操作：分别编译两个源文件并比较引脚声明。

预期：两者均被接受，引脚名称、阈值与初始意图声明相同。

## 对照输入

```json
{
  "omitted": "device EmptyIntent { pin input; }",
  "explicit": "device EmptyIntent { pin input = []; }"
}
```

## 执行步骤

```typescript
const models = [];
for (const source of [inputs.omitted, inputs.explicit]) {
  models.push(await adapter.compileDDL(source));
}
```

## 断言

```typescript
assert.equal(models.length, 2);
for (const model of models) {
  assert.equal(model.kind, 'device');
  assert.equal(model.name, 'EmptyIntent');
  const pins = model.declarations.filter((item) => item.kind === 'pin');
  assert.equal(pins.length, 1);
  assert.equal(pins[0].name, 'input');
}
```
