---
kind: simulation
---

# 器件库捕获登记并可跨板复用

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 库创建时 MUST 校验并捕获模型的自有内容及登记关系，拒绝重复类型标识；后续改变输入数组或模型对象不改变库。工厂保留函数引用，捕获不复制或冻结其闭包。库只持有定义，可供多个板复用，不拥有板运行资源；其生命周期由宿主引用管理。

## 验收义务

前提：登记一个 `probe` 类型后，把输入数组的该元素替换为另一个模型与抛错工厂，并在数组中追加一个 `extra` 类型；库已在此前创建。

操作：用同一库建立两块板并各自推进到 0，再尝试用 `extra` 类型建立第三块板。

预期：两块板都用登记时的模型与工厂，输出各为 [1] 且工厂共调用两次；`extra` 从未进入库，第三块板在工厂前以 INVALID_CONFIGURATION 拒绝，替换工厂与 `extra` 工厂都不执行。

## 模型

<!-- prettier-ignore -->
```ddl
device HostProbe {
  output channel out: number(capacity: 2);
  process start {
    out.send(1);
  }
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
  "nets": []
}
```

## 执行步骤

```typescript
const { diagnostic } = await importModule('./fixture.mjs');
const model = await adapter.compileDDL(modelSource);
const extra = await adapter.compileDDL(
  `device Extra { output channel out: number(capacity: 1); process start { out.send(2); } }`,
);

let calls = 0;
let extraCalls = 0;
const delivered = [];
const entries = [
  {
    id: 'probe',
    model,
    create() {
      calls++;
      return {
        sync(batch) {
          delivered.push(batch.outputs.out.length);
        },
        dispose() {},
      };
    },
  },
];
const library = adapter.createDeviceLibrary(entries);

entries[0] = {
  id: 'probe',
  model: extra,
  create() {
    throw new Error('replacement factory must not be used');
  },
};
entries.push({
  id: 'extra',
  model: extra,
  create() {
    extraCalls++;
    return { sync() {}, dispose() {} };
  },
});

const first = adapter.createBoard(library, description);
const second = adapter.createBoard(library, description);
t.after(() => {
  first.dispose();
  second.dispose();
});
first.runUntil(0);
second.runUntil(0);
```

## 断言

```typescript
assert.equal(calls, 2);
assert.deepEqual(delivered, [1, 1]);
assert.equal(first.status, 'ready');
assert.equal(second.status, 'ready');

assert.throws(
  () =>
    adapter.createBoard(library, {
      instances: [{ id: 'third', type: 'extra' }],
      nets: [],
    }),
  diagnostic('INVALID_CONFIGURATION'),
);
assert.equal(extraCalls, 0);
```
