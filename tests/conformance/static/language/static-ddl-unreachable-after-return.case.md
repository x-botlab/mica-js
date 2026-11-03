---
kind: compile
---

# static-ddl-unreachable-after-return

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> return、break、continue、redirect 后继续追加同路径语句属于静态错误。if 或 match 全部分支终结时，外层路径也终结。没有可达 break 的 loop 不形成正常结束路径；while 不通过一般常量计算证明其必然进入或不结束。

## 验收义务

前提：函数的 return 后仍有同路径局部声明。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
fn read() -> number {
return 1;
const later = 2;
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
await assert.rejects(compile, '拒绝同一路径 return 后的语句。');
```
