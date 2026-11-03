---
format: mica-case/v1
id: static-ddl-initial-now
kind: compile
---

# static-ddl-initial-now

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> 创建期函数调用链只能读取参数、局部、属性与器件级 const；不能读取 state、derived、pin.sample 或 memory，也不能调用 random、now 或产生资源效果。检查沿调用图传播，函数写为 pure 不能替代此处更窄的读取要求。

## 验收义务

前提：pin 初值的条件表达式调用 now。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
pin probe = now() == 0 ? [] : [];
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
await assert.rejects(compile, '拒绝初始意图读取 now。');
```
