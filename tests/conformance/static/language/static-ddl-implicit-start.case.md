---
kind: compile
---

# static-ddl-implicit-start

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> 其他过程必须显式写 ``process name on source``；不提供 ``on start`` 形式或无 on 的任意名称入口。过程不能像 fn 一样被调用。

## 验收义务

前提：命名过程既不是 start，也未指定 on 源。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
process run {}
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
await assert.rejects(compile, '拒绝无 on 的任意命名过程。');
```
