---
format: mica-case/v1
id: language-atomic-reserved-name
kind: compile
---

# reserved-name

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 结构关键字包括 ``device``、``default``、``const``、``let``、``enum``、``record``、``state``、``derived``、``pin``、``memory``、``fn``、``pure``、``process``、``on``、``reaction``、``as``、``capture``、``if``、``else``、``match``、``while``、``loop``、``break``、``continue``、``return``、``await``、``assert`` 与 ``redirect``；``true``、``false``、``none`` 为值记号。它们不能作为用户声明名称。

## 验收义务

前提：state 试图使用 if 作为名称。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
state if: number = 0;
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
