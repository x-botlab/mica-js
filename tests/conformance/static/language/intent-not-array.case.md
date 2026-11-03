---
format: mica-case/v1
id: language-atomic-intent-not-array
kind: compile
---

# intent-not-array

## 规范来源

[docs/spec/appendices/grammar.rst](../../../../docs/spec/appendices/grammar.rst)

<!-- prettier-ignore -->
> bytes 为构造语法，不能作为普通值名称再解释为数组索引。``[ ... ]`` 只组合 intent，不是一般数组。

## 验收义务

前提：局部 const 使用方括号列表包含两个 number。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
fn read() { const values = [1, 2]; }
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
