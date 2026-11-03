---
kind: compile
---

# raw-string-newline

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 字符串使用双引号，支持 ``\"``、``\\``、``\n``、``\r``、``\t``、``\uXXXX`` 和 ``\u{...}`` 转义。``\uXXXX`` 表示一个 UTF-16 代码单元；码点形式的数值范围为 0 至 0x10ffff。非法转义与未转义换行在编译时拒绝。

## 验收义务

前提：一个双引号字符串跨越真实换行。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```json
{
  "source": "device Atomic {\nconst text = \"first\nsecond\";\n}"
}
```

## 执行步骤

```typescript
const { validateDDL } = await importModule('../assertions.mjs');
const compile = () => validateDDL(adapter, input.source);
```

## 断言

```typescript
await assert.rejects(compile);
```
