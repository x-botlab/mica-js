---
format: mica-case/v1
id: language-atomic-decimal-digits
kind: compile
---

# decimal-digits

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 支持十进制整数、小数、科学计数法以及 ``0x``、``0b``、``0o`` 前缀的整数字面量。小数点两侧都要有数字，例如 ``0.5`` 与 ``1.0``；``.5`` 与 ``1.`` 不是合法字面量。指数部分可以有正负号。前缀大小写均可使用。

## 验收义务

前提：两份独立输入分别省略小数点左侧或右侧的数字。

操作：编译该 device 定义。

预期：编译拒绝这两份定义。

## 输入

<!-- prettier-ignore -->
```json
{
  "sources": [
    "device Atomic {\nconst value = .5;\n}",
    "device Atomic {\nconst value = 1.;\n}"
  ]
}
```

## 执行步骤

```typescript
const { validateDDL } = await importModule('../assertions.mjs');
const sources = input.sources;
```

## 断言

```typescript
for (const source of sources) {
  await assert.rejects(() => validateDDL(adapter, source));
}
```
