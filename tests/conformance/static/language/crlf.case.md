---
format: mica-case/v1
id: language-atomic-crlf
kind: compile
---

# crlf

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 源文件采用 UTF-8，可以包含文件开头的 BOM；接受 LF 与 CRLF。换行编码不改变模型含义。

## 验收义务

前提：单一 device 的两处换行均为 CRLF，不包含 BOM。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记。

## 输入

<!-- prettier-ignore -->
```json
{
  "source": "device Atomic {\r\nconst value = 1;\r\n}"
}
```

## 执行步骤

```typescript
const model = await adapter.compileDDL(typeof input === 'string' ? input : input.source);
let factoryCalls = 0;
```

## 断言

```typescript
assert.equal(model.kind, 'device');
assert.equal(model.name, 'Atomic');
const library = adapter.createDeviceLibrary([
  {
    id: 'language/atomic',
    model,
    create() {
      factoryCalls++;
      return { sync() {}, dispose() {} };
    },
  },
]);
assert.ok(library);
assert.equal(factoryCalls, 0);
```
