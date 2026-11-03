---
kind: compile
---

# record-missing-field

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 字段通过 ``value.field`` 读取。缺失、重复、多余或类型错误的字段静态拒绝。不同具名记录不隐式互换；转换时显式构造目标记录。字段不可赋值，更改内容通过构造新记录并替换允许写入的绑定实现。

## 验收义务

前提：目标记录要求 value 和 ready，字面量只提供 value。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
record Item { value: number; ready: bool; }
const item: Item = { value: 1 };
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
