---
kind: compile
---

# static-ddl-initial-nullable

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> pin 声明可在阈值之后以 ``= expression`` 指定非可空 ``intent`` 初值；省略时为 ``[]``。初值采用上述创建期意图表达式，求值与支路构造校验均在任何工厂调用前完成。

## 验收义务

前提：pin 初值来自返回 intent? 的 pure fn。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
pure fn bias() -> intent? {
return none;
}
pin probe = bias();
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
await assert.rejects(compile, '拒绝可空 intent 作为 pin 初值。');
```
