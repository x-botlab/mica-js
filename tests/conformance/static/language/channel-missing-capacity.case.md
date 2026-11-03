---
format: mica-case/v1
id: language-atomic-channel-missing-capacity
kind: compile
---

# channel-missing-capacity

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> 方向以 DDL 为参照，声明必须显式 input 或 output。通道的 capacity 必填，overflow 可省略；bytes 通道另需 maxLength，其他负载不能带该选项。选项名不可重复，容量、上限与策略均为创建期表达式。

## 验收义务

前提：number input channel 只指定 overflow，没有指定 capacity。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
input channel incoming: number(overflow: Overflow.error);
}
```

## 执行步骤

```typescript
const { validateDDL } = await importModule('../assertions.mjs');
const compile = () => validateDDL(adapter, input);
```

## 断言

```typescript
await assert.rejects(compile);
```
