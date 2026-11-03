---
format: mica-case/v1
id: host-explicit-undefined-seed-before-factory
kind: simulation
---

# host-explicit-undefined-seed-before-factory

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 只有省略可选字段才采用默认；显式 ``undefined`` 按非法类型处理，``null`` 仅在属性声明允许可空值时接受；创建入口将这类参数原因封装进配置失败诊断。

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 库或板的创建入口统一将配置、模型及初始化失败封装为 SimulationError，底层 TypeError、RangeError 或 BuildError 保留在 cause，见下方创建失败规则。

[docs/spec/conformance.rst](../../../docs/spec/conformance.rst)

<!-- prettier-ignore -->
> 创建入口均抛 SimulationError 且不交付板；配置原因用 INVALID_CONFIGURATION，模型校验用 MODEL_VALIDATION_FAILED，创建期求值及断言失败用 MODEL_EXECUTION_FAILED、phase 为 assembly；已有专用分类码时保留。原始参数或模型校验异常引用保留于 error.diagnostic.cause，工厂调用次数为零。

## 验收义务

前提：模型与装配合法，工厂记录调用次数；创建选项显式传入 seed: undefined。

操作：同步创建板。

预期：创建入口在工厂前以 INVALID_CONFIGURATION 拒绝，底层 TypeError 保留在 diagnostic.cause，工厂调用次数为零。

## 模型

```ddl
device HostProbe {}
```

## 装配

```json
{ "instances": [{ "id": "probe", "type": "probe" }], "nets": [] }
```

## 执行步骤

```typescript
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
assert.throws(
  () => {
    const board = adapter.createBoard(library, description, { seed: undefined });
    t.after(board.dispose.bind(board));
  },
  (error) => {
    assert.equal(error.code, 'INVALID_CONFIGURATION');
    assert.ok(error.diagnostic.cause instanceof TypeError);
    return true;
  },
);
assert.equal(calls, 0);
```
