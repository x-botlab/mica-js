---
kind: simulation
---

# 装配标识与端点错误先于任何工厂

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 库类型 ID、实例 ID 与网络 ID MUST 为非空字符串，按原始内容精确比较，不裁剪或规范化；实例和网络分别在自己的集合内唯一。引脚端点使用 ``{ instance, pin }``，不拼接字符串路径。``nets[].voltage`` 是可选有限电压，0 表示地，省略表示无理想参考；没有第二个 ground 字段。重复网络 ID、同网重复端点或跨网重复端点均为装配错误。

## 验收义务

前提：模型与合法的两引脚装配已就绪，工厂记录调用次数；随后分别构造重复网络 ID、同一端点出现在两个网络、以及空网络 ID 的三份描述。

操作：依次同步创建三块板并捕获每次失败。

预期：三份描述都在任何工厂调用前以 INVALID_CONFIGURATION 拒绝；工厂调用次数始终为零，且拒绝不产生半成品板。

## 模型

<!-- prettier-ignore -->
```ddl
device HostProbe {
  pin a;
  pin b;
}
```

## 装配

```json
{
  "instances": [
    {
      "id": "probe",
      "type": "probe"
    }
  ],
  "nets": [
    {
      "id": "link",
      "pins": [
        {
          "instance": "probe",
          "pin": "a"
        }
      ]
    }
  ]
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

const duplicateNetId = {
  instances: description.instances,
  nets: [
    { id: 'link', pins: [{ instance: 'probe', pin: 'a' }] },
    { id: 'link', pins: [{ instance: 'probe', pin: 'b' }] },
  ],
};
const crossNetEndpoint = {
  instances: description.instances,
  nets: [
    { id: 'one', pins: [{ instance: 'probe', pin: 'a' }] },
    { id: 'two', pins: [{ instance: 'probe', pin: 'a' }] },
  ],
};
const emptyNetId = {
  instances: description.instances,
  nets: [{ id: '', pins: [] }],
};

const legal = adapter.createBoard(library, description);
t.after(legal.dispose.bind(legal));
```

## 断言

```typescript
assert.equal(legal.status, 'ready');
assert.equal(calls, 1);

for (const candidate of [duplicateNetId, crossNetEndpoint, emptyNetId]) {
  assert.throws(
    () => adapter.createBoard(library, candidate),
    diagnostic('INVALID_CONFIGURATION'),
  );
}
assert.equal(calls, 1);
```
