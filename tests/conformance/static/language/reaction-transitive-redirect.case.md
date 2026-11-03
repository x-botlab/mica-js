---
kind: compile
---

# reaction-transitive-redirect

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> 响应体允许普通同步效果，包括 state / memory 更新、intent 替换、output 发送与通知、now、random、assert 及同步函数调用。MUST NOT 等待、receive 或 redirect，包括经辅助函数间接产生的这些效果；return 仅结束当前响应。

## 验收义务

前提：响应体调用包含 redirect 的普通函数。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
state count: number = 0;
fn jump() { redirect(1); }
reaction observe on count as (before, after) { jump(); }
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
