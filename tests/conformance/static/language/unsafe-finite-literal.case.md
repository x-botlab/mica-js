---
kind: compile
---

# unsafe-finite-literal

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 字面量转换为最接近的 binary64 值，等距时取偶数尾数。有限但不安全的整数仍是合法 ``number``；操作需要安全整数时另行检查。转换溢出为无穷大的字面量在编译时拒绝，使用 ``Infinity`` 显式表达无穷大。

## 验收义务

前提：器件级 const 的初值是 9007199254740992，超过安全整数上界但仍是有限值。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
const unsafe = 9007199254740992;
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
