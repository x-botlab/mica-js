---
kind: compile
---

# string-concatenation

## 规范来源

[docs/spec/language/expressions.rst](../../../../docs/spec/language/expressions.rst)

<!-- prettier-ignore -->
> * - ``+``、``-``
>      - number、number；+ 另接受 string、string。
>      - number 或 string。

## 验收义务

前提：器件级 const 用 + 依次连接三个字符串字面量。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
const label = "mica" + "-" + "js";
}
```

## 执行步骤

```typescript
const { validateDDL } = await importModule('../assertions.mjs');
const model = await validateDDL(adapter, input);
```

## 断言

```typescript
assert.equal(model.kind, 'device');
assert.equal(model.name, 'Atomic');
```
