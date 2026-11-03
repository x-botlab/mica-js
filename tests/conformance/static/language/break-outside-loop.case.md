---
format: mica-case/v1
id: language-atomic-break-outside-loop
kind: compile
---

# break-outside-loop

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> ``break;`` 跳出最近一层循环，``continue;`` 开始该循环的下一轮；在 while 中重新求条件。循环外使用两者静态拒绝。

## 验收义务

前提：启动过程体内直接使用 break，该路径不处于任何循环中。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
process start { break; }
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
