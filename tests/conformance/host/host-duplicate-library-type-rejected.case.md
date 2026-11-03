---
format: mica-case/v1
id: host-duplicate-library-type-rejected
kind: simulation
---

# host-duplicate-library-type-rejected

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 库创建时 MUST 校验并捕获模型的自有内容及登记关系，拒绝重复类型标识；后续改变输入数组或模型对象不改变库。

[docs/spec/conformance.rst](../../../docs/spec/conformance.rst)

<!-- prettier-ignore -->
> ID 与 model.name 独立，不要求 DDL 源码或额外类型名字段；合法模型均能装配，重复登记报 INVALID_CONFIGURATION、phase 为 library。

## 验收义务

前提：同一合法模型与同一工厂以相同类型 ID 登记两次。

操作：同步创建器件库。

预期：库创建以 INVALID_CONFIGURATION 拒绝；工厂不执行；函数与模型引用相同不豁免类型 ID 唯一性。

## 模型

```ddl
device HostProbe {}
```

## 装配

```json
{ "instances": [], "nets": [] }
```

## 执行步骤

```typescript
const { diagnostic } = await importModule('./fixture.mjs');
const model = await adapter.compileDDL(modelSource);
let calls = 0;
const entry = {
  id: 'probe',
  model,
  create() {
    calls++;
    return { sync() {}, dispose() {} };
  },
};
```

## 断言

```typescript
assert.throws(
  () => adapter.createDeviceLibrary([entry, entry]),
  diagnostic('INVALID_CONFIGURATION'),
);
assert.equal(calls, 0);
```
