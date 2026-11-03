---
format: mica-case/v1
id: static-ddl-invalid-separator
kind: compile
---

# static-ddl-invalid-separator

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 数字之间允许单个下划线，例如 ``1_000``、``0xff_ff``、``1.25e+3``。下划线不能位于前缀后、结尾、小数点或指数标记旁，也不能连续出现。前导零不产生旧式八进制解释。负号是独立的一元运算。

## 验收义务

前提：十进制字面量含连续两个下划线。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
const value = 1__000;
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
await assert.rejects(compile, '拒绝连续下划线数值分隔符。');
```
