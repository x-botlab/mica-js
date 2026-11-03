---
format: mica-case/v1
id: static-ddl-reaction-wait
kind: compile
---

# static-ddl-reaction-wait

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> 响应体允许普通同步效果，包括 state / memory 更新、intent 替换、output 发送与通知、now、random、assert 及同步函数调用。MUST NOT 等待、receive 或 redirect，包括经辅助函数间接产生的这些效果；return 仅结束当前响应。

## 验收义务

前提：reaction 响应体直接 await ticks。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
state count: number = 0; reaction observe on count as (before, after) { await ticks(1); }
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
await assert.rejects(compile, '拒绝 reaction 响应体等待。');
```
