---
kind: compile
---

# static-ddl-process-call

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> 其他过程必须显式写 ``process name on source``；不提供 ``on start`` 形式或无 on 的任意名称入口。过程不能像 fn 一样被调用。

## 验收义务

前提：普通 fn 试图调用带 on 的命名 process。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
state count: number = 0;
process observe on count {}
fn callProcess() {
observe();
}
}
```

## 执行步骤

```typescript
const compile = async () => {
  await adapter.compileDDL(input);
};
```

## 断言

```typescript
await assert.rejects(compile, '拒绝像普通函数一样调用 process。');
```
