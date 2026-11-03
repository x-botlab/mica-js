---
kind: compile
---

# static-ddl-record-extra-field

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 字段通过 ``value.field`` 读取。缺失、重复、多余或类型错误的字段静态拒绝。不同具名记录不隐式互换；转换时显式构造目标记录。字段不可赋值，更改内容通过构造新记录并替换允许写入的绑定实现。

## 验收义务

前提：记录字面量比目标记录类型多一个字段。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
record Item { value: number; }
const item: Item = { value: 1, extra: true };
}
```

## 执行步骤

```typescript
const compile = async () => {
  await adapter.compileDDL(input);
};
```

## 断言

```typescript
await assert.rejects(compile, '拒绝 DDL 记录字面量的额外字段。');
```
