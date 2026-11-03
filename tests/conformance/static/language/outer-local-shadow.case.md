---
kind: compile
---

# outer-local-shadow

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 参数、局部绑定不能遮蔽当前可见的器件成员、参数或外层局部。兄弟块中互不包含的局部可以复用名称。局部名称在自身初始化完成后可用，初始化不能读取自身。``const`` 与 ``let`` 都必须有初值。

## 验收义务

前提：if 内 let 与外层可见 let 同名。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
fn read(flag: bool) {
let value = 1;
if flag {
let value = 2;
}
}
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
