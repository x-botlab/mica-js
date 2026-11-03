---
kind: compile
---

# static-ddl-intent-equality

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> ``intent`` 是支路组合值，``sample`` 是已发布的只读采样快照。两者可以保存到局部、传参、返回或形成可空值；intent 构造与 sample 字段由 :doc:`builtins`、:doc:`/electrical` 定义。sample 按字段相等，intent 不提供相等比较；intent? 仍可与 none 比较。

## 验收义务

前提：函数内保存两个 `resistor` 构造的 intent，并用 `==` 比较二者内容。

操作：编译该 device 定义。

预期：intent 不提供相等比较，该定义被静态拒绝并给出非空诊断消息；同特性合法形式见 `static-ddl-initial-props-pure`。

## 输入

```ddl
device StaticFixture {
pin probe(low: 0.8, high: 2.0);
fn same() -> bool {
const first = resistor(to: probe, resistance: 1000);
const second = resistor(to: probe, resistance: 1000);
return first == second;
}
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
