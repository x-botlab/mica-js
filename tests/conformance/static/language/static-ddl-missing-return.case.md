---
format: mica-case/v1
id: static-ddl-missing-return
kind: compile
---

# static-ddl-missing-return

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> 函数返回零个或一个值，记录可以作为一个返回值。无返回值函数省略返回类型，正常结束可以写 ``return;`` 或到达函数体末尾；有返回值函数的每个可正常结束路径都必须返回匹配的值。

## 验收义务

前提：有返回值函数的 if 未命中路径可正常到达函数末尾。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
fn read(flag: bool) -> number { if flag { return 1; } }
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
await assert.rejects(compile, '拒绝有值函数存在正常结束却未返回的路径。');
```
