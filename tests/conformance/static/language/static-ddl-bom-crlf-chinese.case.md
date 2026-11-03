---
kind: compile
---

# static-ddl-bom-crlf-chinese

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

## 验收义务

前提：源文件含开头 BOM、CRLF 换行和中文字符串。

操作：编译该源文件。

预期：接受该文件；BOM 与 CRLF 不改变模型含义。

## 输入

```json
{
  "source": "﻿device StaticFixture {\r\nstate label: string = \"中文\";\r\n}"
}
```

## 执行步骤

```typescript
const model = await adapter.compileDDL(input.source);
let factoryCalls = 0;
```

## 断言

```typescript
assert.ok(
  model && typeof model === 'object',
  '接受文件头 BOM、CRLF 与中文字符串；不声称验证列定位或文本模型等价。',
);
assert.equal(model.kind, 'device');
assert.equal(model.name, 'StaticFixture');
assert.ok(Array.isArray(model.declarations));
const library = adapter.createDeviceLibrary([
  {
    id: 'static/fixture',
    model,
    create() {
      factoryCalls++;
      return { sync() {}, dispose() {} };
    },
  },
]);
assert.ok(library && typeof library === 'object');
assert.equal(factoryCalls, 0, 'Library registration must not invoke factories');
```
