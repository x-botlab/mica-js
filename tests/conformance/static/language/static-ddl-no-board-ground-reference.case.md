---
kind: compile
---

# static-ddl-no-board-ground-reference

## 规范来源

[docs/spec/language/builtins.rst](../../../../docs/spec/language/builtins.rst)

<!-- prettier-ignore -->
> 器件通过普通供电与地引脚连接板级固定电位网络。DDL 没有内建的 ground 引用或 drive 构造；板级理想参考不进入器件资源系统。

## 验收义务

前提：初始意图引用没有用户声明的 ground。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
pin probe = [resistor(to: ground, resistance: 1000)];
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
await assert.rejects(compile, '拒绝直接引用不存在的板级 ground；不把普通供电 pin 误作板级参考。');
```
