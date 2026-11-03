---
kind: compile
---

# creation-derived-read

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> 创建期函数调用链只能读取参数、局部、属性与器件级 const；不能读取 state、derived、pin.sample 或 memory，也不能调用 random、now 或产生资源效果。检查沿调用图传播，函数写为 pure 不能替代此处更窄的读取要求。

## 验收义务

前提：器件级 const 调用 pure fn，该函数读取由 state 派生的值。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
state count: number = 1;
derived current: number = count;
pure fn read() -> number { return current; }
const initial = read();
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
