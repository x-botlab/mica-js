---
kind: compile
---

# static-ddl-logic-enum-comparison

## 规范来源

[docs/spec/language/builtins.rst](../../../../docs/spec/language/builtins.rst)

<!-- prettier-ignore -->
> ``Logic``、``SampleStatus`` 与 ``Overflow`` 为内置具名枚举。前两者的成员由 :doc:`/electrical` 维护；``Overflow`` 的成员为 ``drop_new``、``drop_oldest`` 和 ``error``，语义见 :doc:`/channels`。用户枚举采用相同的具名成员与类型身份规则。

[docs/spec/electrical.rst](../../../../docs/spec/electrical.rst)

<!-- prettier-ignore -->
> ``Logic`` 的完整成员为 ``low``、``high``、``unknown``。逻辑解释使用本章接收阈值规则；所有电压均为相对板级统一地坐标的值。

## 验收义务

前提：过程把 `probe.sample.level` 与内置成员 `Logic.high` 作相等比较。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功；内置枚举成员可用于同类型相等比较，sample 字段在普通过程中可读。

## 输入

```ddl
device StaticFixture {
pin probe(low: 0.8, high: 2.0);
state detected: bool = false;
process start {
if probe.sample.level == Logic.high {
detected = true;
}
}
}
```

## 执行步骤

```typescript
const { validateDDL } = await importModule('../assertions.mjs');
const model = await validateDDL(adapter, input);
```

## 断言

```typescript
assert.equal(model.kind, 'device');
assert.equal(model.name, 'StaticFixture');
assert.ok(Array.isArray(model.declarations));
```
