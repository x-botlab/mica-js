---
format: mica-case/v1
id: host-unknown-later-type-before-factories
kind: simulation
---

# host-unknown-later-type-before-factories

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 库登记、板描述、props 或 options 非法，包括重复登记或装配 ID、未知器件类型及未声明属性；存在专用分类码时使用相应专用码。

[docs/spec/conformance.rst](../../../docs/spec/conformance.rst)

<!-- prettier-ignore -->
> 创建入口均抛 SimulationError 且不交付板；配置原因用 INVALID_CONFIGURATION，模型校验用 MODEL_VALIDATION_FAILED，创建期求值及断言失败用 MODEL_EXECUTION_FAILED、phase 为 assembly；已有专用分类码时保留。原始参数或模型校验异常引用保留于 error.diagnostic.cause，工厂调用次数为零。

## 验收义务

前提：器件库只登记 probe；板描述先引用 probe，再引用未登记的 missing。

操作：同步创建板并记录工厂调用。

预期：在任何工厂调用前以 INVALID_CONFIGURATION 拒绝整板配置，不交付半成品，工厂调用次数为零。

## 模型

```ddl
device HostProbe {}
```

## 装配

```json
{
  "instances": [
    { "id": "first", "type": "probe" },
    { "id": "last", "type": "missing" }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const { diagnostic } = await importModule('./fixture.mjs');
const model = await adapter.compileDDL(modelSource);
let calls = 0;
const library = adapter.createDeviceLibrary([
  {
    id: 'probe',
    model,
    create() {
      calls++;
      return { sync() {}, dispose() {} };
    },
  },
]);
```

## 断言

```typescript
assert.throws(() => {
  const board = adapter.createBoard(library, description);
  t.after(board.dispose.bind(board));
}, diagnostic('INVALID_CONFIGURATION'));
assert.equal(calls, 0);
```
