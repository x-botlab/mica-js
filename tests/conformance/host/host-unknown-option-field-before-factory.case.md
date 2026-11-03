---
kind: simulation
---

# 未知创建选项在工厂前拒绝

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> ``options`` 仅接受 ``seed``，其他字段按未知配置拒绝。声明数值合法不等于宿主能够分配；已知配置与资源建立错误在工厂前拒绝，建立失败报告 ``RESOURCE_ALLOCATION_FAILED``。

[docs/spec/conformance.rst](../../../docs/spec/conformance.rst)

<!-- prettier-ignore -->
> 从 TypeScript 及普通 JavaScript 创建选项，尝试传入已移除的 sameTimeBudget 字段。 | 类型合同拒绝该额外字段；运行时按未知配置字段拒绝，不启用隐式默认计数或旧预算诊断。

## 验收义务

前提：模型与装配合法，工厂记录调用次数；创建选项同时给出合法的 `seed: 0` 与已移除的 `sameTimeBudget`。

操作：同步创建板。

预期：创建入口在工厂前以 INVALID_CONFIGURATION 拒绝，不启用隐式计数或旧预算诊断；工厂调用次数为零。

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

const legal = adapter.createBoard(library, description, { seed: 0 });
t.after(legal.dispose.bind(legal));
```

## 断言

```typescript
assert.equal(legal.status, 'ready');
assert.equal(calls, 1);

assert.throws(
  () => adapter.createBoard(library, description, { seed: 0, sameTimeBudget: 64 }),
  (error) => {
    assert.equal(error.code, 'INVALID_CONFIGURATION');
    return true;
  },
);
assert.equal(calls, 1);
```
