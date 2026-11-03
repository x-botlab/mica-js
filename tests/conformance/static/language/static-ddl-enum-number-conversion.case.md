---
format: mica-case/v1
id: static-ddl-enum-number-conversion
kind: compile
---

# static-ddl-enum-number-conversion

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 枚举在 device 内声明，至少一个成员，成员名唯一，使用 ``Mode.idle`` 引用。每个枚举保留具名类型身份；即使两个类型成员同名，也不能互换。成员没有公开数值编码，不提供与 number 的转换。

## 验收义务

前提：number state 的初值为枚举成员。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
enum Mode { idle, active } state mode: number = Mode.idle;
}
```

## 执行步骤

```typescript
assert.equal(typeof adapter.compileDDL, 'function');
const compile = async () => {
  await adapter.compileDDL(input);
};
```

## 断言

```typescript
await assert.rejects(compile, '拒绝枚举到 number 的隐式转换。');
```
