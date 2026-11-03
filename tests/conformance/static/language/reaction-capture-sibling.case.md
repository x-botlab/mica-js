---
format: mica-case/v1
id: language-atomic-reaction-capture-sibling
kind: compile
---

# reaction-capture-sibling

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> 捕获表达式遵循现有纯表达式规则，可以读取属性、常量、state、derived、sample 和 memory，调用 pure fn；不另设更窄的读取集合。每项捕获独立求值，不能引用 previous / current、自身或其他 capture 名称。

## 验收义务

前提：第二项 capture 的初始化表达式引用第一项 capture 名称。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
state count: number = 0;
reaction observe on count as (before, after) capture first = count, second = first {}
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
