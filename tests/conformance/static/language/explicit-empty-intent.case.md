---
format: mica-case/v1
id: markdown-explicit-empty-intent
kind: compile
---

# 显式空意图编译

此样本只验证显式空意图的编译接受与阈值声明，不验证运行时的空意图等价性。

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> pin 声明可在阈值之后以 ``= expression`` 指定非可空 ``intent`` 初值；省略时为 ``[]``。初值采用上述创建期意图表达式，求值与支路构造校验均在任何工厂调用前完成。

## 验收义务

前提：唯一的 pin 显式初始化为 []，并省略 low 和 high。

操作：编译该 device 定义，并检查器件声明中对应 pin 的阈值字段。

预期：编译成功；该 pin 的 `low` 与 `high` 均为 `undefined`。

## 输入

```ddl
device EmptyIntent {
  pin input = [];
}
```

## 执行步骤

```typescript
const model = await adapter.compileDDL(input);
const pins = model.declarations.filter((item) => item.kind === 'pin');
```

## 断言

```typescript
assert.equal(model.kind, 'device');
assert.equal(model.name, 'EmptyIntent');
assert.equal(pins.length, 1);
assert.equal(pins[0].name, 'input');
assert.equal(pins[0].low, undefined);
assert.equal(pins[0].high, undefined);
```
