---
kind: compile
---

# static-ddl-branch-local-escape

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 参数、局部绑定不能遮蔽当前可见的器件成员、参数或外层局部。兄弟块中互不包含的局部可以复用名称。局部名称在自身初始化完成后可用，初始化不能读取自身。``const`` 与 ``let`` 都必须有初值。

## 验收义务

前提：函数在 if 分支声明局部，离开分支后读取该局部。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
fn read(flag: bool) -> number {
if flag {
const saved = 1;
}
return saved;
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
await assert.rejects(compile, '拒绝在分支外引用仅在分支内声明的局部。');
```
