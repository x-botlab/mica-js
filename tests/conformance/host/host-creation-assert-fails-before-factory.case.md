---
kind: simulation
---

# 创建期断言失败先于工厂

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 创建期模型表达式求值或器件体 assert 失败使用 ``MODEL_EXECUTION_FAILED``、``phase: 'assembly'``，发生于工厂调用前；底层执行或断言失败原因保留在 ``diagnostic.cause``。静态模型不合法仍使用 ``MODEL_VALIDATION_FAILED``，配置输入不合法使用 ``INVALID_CONFIGURATION``；已有专用分类码的错误继续使用专用码。

[docs/spec/assembly.rst](../../../docs/spec/assembly.rst)

<!-- prettier-ignore -->
> 对全板各实例执行器件体创建期 ``assert``，全部通过后才进入资源建立阶段。

## 验收义务

前提：属性 `limit` 的默认值是 1，装配为实例提供 0；器件体以 `assert limit > 0` 拒绝该配置，工厂记录调用次数。

操作：同步创建板并捕获失败。

预期：创建入口在任何工厂调用前抛出 MODEL_EXECUTION_FAILED、phase 为 assembly 的 `SimulationError`，保留断言失败原因；工厂调用次数为零，不交付板。

## 模型

<!-- prettier-ignore -->
```ddl
device HostProbe(limit: number default 1) {
  assert limit > 0, "limit must be positive";
}
```

## 装配

```json
{
  "instances": [
    {
      "id": "probe",
      "type": "probe",
      "props": {
        "limit": 0
      }
    }
  ],
  "nets": []
}
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
  () => adapter.createBoard(library, description),
  (error) => {
    assert.equal(error.code, 'MODEL_EXECUTION_FAILED');
    assert.equal(error.diagnostic.phase, 'assembly');
    assert.ok(error.diagnostic.cause instanceof Error);
    return true;
  },
);
assert.equal(calls, 0);
```
