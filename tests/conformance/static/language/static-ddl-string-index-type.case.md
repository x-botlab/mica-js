---
kind: compile
---

# static-ddl-string-index-type

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> ``string`` 是不可变 UTF-16 代码单元序列。字符串之间可以拼接和比较相等，不与 number 等其他类型隐式转换。``value.length`` 返回代码单元数量；``value[index]`` 返回一个代码单元构成的 string。它不按字素或 Unicode 码点索引。

## 验收义务

前提：有返回值函数声明返回 number，实际返回字符串索引结果。

操作：先编译仅修正该错误点的近邻定义（见执行步骤），再编译该 device 定义。

预期：字符串索引产生 string 而非 number，该定义被静态拒绝并给出非空诊断消息；近邻仅把返回类型改为 string 即合法。

## 输入

```ddl
device StaticFixture {
fn first() -> number { return "abc"[0]; }
}
```

## 执行步骤

```typescript
const neighbor = `device StaticFixture {
fn first() -> string {
return "abc"[0];
}
}`;
const accepted = await adapter.compileDDL(neighbor);
assert.equal(accepted.kind, 'device');
const compile = () => adapter.compileDDL(input);
```

## 断言

```typescript
await assert.rejects(compile, (error) => {
  assert.ok(error instanceof Error, '编译拒绝必须抛出 Error。');
  assert.ok(error.message.length > 0, '编译诊断必须给出非空消息。');
  return true;
});
```
