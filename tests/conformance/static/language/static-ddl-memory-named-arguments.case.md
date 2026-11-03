---
kind: compile
---

# static-ddl-memory-named-arguments

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 内置类型、枚举、常量与函数名称由 :doc:`types` 和 :doc:`builtins` 给出，不能被用户声明遮蔽。命名实参的标签和成员访问按对应声明匹配；例如内置存储函数接受 ``memory: data`` 标签，该标签不声明一个名为 ``memory`` 的局部。

## 验收义务

前提：读写与快照函数全部使用命名实参，其中 `memory:` 标签按任意顺序出现。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功；存储操作的命名标签不引入名为 memory 的局部，`copyBytes` 返回 bytes。

## 输入

```ddl
device StaticFixture {
memory data[4];
fn write() {
store8(memory: data, offset: 0, value: 1);
}
fn read() -> number { return load8(offset: 0, memory: data); }
fn header() -> bytes { return copyBytes(memory: data, offset: 0, length: 2); }
}
```

## 执行步骤

```typescript
const { validateDDL } = await importModule('../assertions.mjs');
const model = await validateDDL(adapter, input);
```

## 断言

```typescript
assert.equal(model.kind, 'device');
assert.equal(model.name, 'StaticFixture');
assert.ok(Array.isArray(model.declarations));
```
