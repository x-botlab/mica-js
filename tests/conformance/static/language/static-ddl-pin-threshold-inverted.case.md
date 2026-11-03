---
kind: compile
---

# static-ddl-pin-threshold-inverted

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> pin 阈值与 memory 长度使用创建期表达式。pin 的 low、high 使用命名形式，必须同时给出有限且 low < high 的值，或同时省略。省略时仍采样电压与状态，但逻辑电平恒为 unknown；端点等号与完整校验见 :doc:`/electrical`。

## 验收义务

前提：pin 同时给出 low 2.0 与 high 0.8，违反 low < high。

操作：编译该 device 定义。

预期：阈值顺序不满足 low < high，该定义被静态拒绝并给出非空诊断消息；同特性合法形式见 `static-ddl-initial-empty-thresholds`。

## 输入

```ddl
device StaticFixture {
pin probe(low: 2.0, high: 0.8);
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
