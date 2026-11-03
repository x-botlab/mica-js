---
format: mica-case/v1
id: static-ddl-ticks-no-value
kind: compile
---

# static-ddl-ticks-no-value

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> 接收结果类型由通道决定，也可使用 ``await incoming.receive();`` 丢弃结果。ticks 无返回值，不能用于初始化或赋值。有返回值的等待结果仍须匹配目标类型，不能写入只读名称。await 不能嵌入算术、实参、短路条件或 ``return`` 的右侧；普通 fn 中所有等待形式均拒绝。

## 验收义务

前提：过程以 await ticks 的无值结果初始化局部。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
process start { const value = await ticks(1); }
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
await assert.rejects(compile, '拒绝用无值 ticks 等待初始化局部。');
```
