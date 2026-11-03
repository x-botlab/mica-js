---
format: mica-case/v1
id: static-ddl-two-starts
kind: compile
---

# static-ddl-two-starts

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> ``process start`` 是可选且唯一的启动过程，只在每块新板的启动阶段运行一次。

## 验收义务

前提：device 声明两个启动过程。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
process start {} process start {}
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
await assert.rejects(compile, '拒绝重复 process start。');
```
