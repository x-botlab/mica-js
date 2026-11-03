---
kind: compile
---

# static-ddl-import

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 每个 ``.ddl`` 文件恰好包含一个 ``device`` 定义。枚举、记录、器件级常量、资源、函数与过程均在该定义内声明。文件自包含；首版语言没有模块、导入导出或跨文件名称解析。

## 验收义务

前提：文件在 device 前使用 import。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
import "other.ddl"; device StaticFixture {}
```

## 执行步骤

```typescript
const compile = async () => {
  await adapter.compileDDL(input);
};
```

## 断言

```typescript
await assert.rejects(compile, '拒绝 import 声明。');
```
