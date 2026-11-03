---
kind: compile
---

# static-ddl-property-record-type

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> * - 属性
>   - number、bool、string、枚举、bytes 及其可空形式。

## 验收义务

前提：device 属性声明为具名记录类型 `Item`。

操作：编译该 device 定义。

预期：记录类型不在属性允许类型表内，该定义被静态拒绝并给出非空诊断消息；同特性合法形式见 `static-ddl-property-nullable`。

## 输入

```ddl
device StaticFixture(item: Item) {
record Item { value: number; }
}
```

## 执行步骤

```typescript
const compile = () => adapter.compileDDL(input);
```

## 断言

```typescript
await assert.rejects(compile, (error) => {
  assert.ok(error instanceof Error, '编译拒绝必须抛出 Error。');
  assert.ok(error.message.length > 0, '编译诊断必须给出非空消息。');
  return true;
});
```
