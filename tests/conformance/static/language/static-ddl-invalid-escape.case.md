---
kind: compile
---

# static-ddl-invalid-escape

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 字符串使用双引号，支持 ``\"``、``\\``、``\n``、``\r``、``\t``、``\uXXXX`` 和 ``\u{...}`` 转义。``\uXXXX`` 表示一个 UTF-16 代码单元；码点形式的数值范围为 0 至 0x10ffff。非法转义与未转义换行在编译时拒绝。

## 验收义务

前提：字符串包含未定义的反斜线 q 转义。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```json
{
  "source": "device StaticFixture {\nstate label: string = \"\\q\";\n}"
}
```

## 执行步骤

```typescript
const compile = async () => {
  await adapter.compileDDL(input.source);
};
```

## 断言

```typescript
await assert.rejects(compile, '拒绝字符串中的未定义转义 \\q。');
```
