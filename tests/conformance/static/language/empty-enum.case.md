---
format: mica-case/v1
id: language-atomic-empty-enum
kind: compile
---

# empty-enum

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 枚举在 device 内声明，至少一个成员，成员名唯一，使用 ``Mode.idle`` 引用。每个枚举保留具名类型身份；即使两个类型成员同名，也不能互换。成员没有公开数值编码，不提供与 number 的转换。

## 验收义务

前提：enum 声明没有任何成员。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
enum Empty {}
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
