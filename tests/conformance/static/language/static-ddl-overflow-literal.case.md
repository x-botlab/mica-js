---
format: mica-case/v1
id: static-ddl-overflow-literal
kind: compile
---

# static-ddl-overflow-literal

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 字面量转换为最接近的 binary64 值，等距时取偶数尾数。有限但不安全的整数仍是合法 ``number``；操作需要安全整数时另行检查。转换溢出为无穷大的字面量在编译时拒绝，使用 ``Infinity`` 显式表达无穷大。

## 验收义务

前提：器件级 const 的字面量为 1e999。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
const value = 1e999;
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
await assert.rejects(compile, '拒绝转换溢出为无穷大的数值字面量。');
```
