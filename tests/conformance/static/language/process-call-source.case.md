---
kind: compile
---

# process-call-source

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> source 为一个静态名称或成员路径，根为本实例 state、derived、pin.sample 或 input notification，字段必须由静态类型确认；不接受调用、运算或动态索引。

## 验收义务

前提：process 的 on 源为 pure fn 调用表达式。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
state count: number = 0;
pure fn read() -> number { return count; }
process observe on read() {}
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
