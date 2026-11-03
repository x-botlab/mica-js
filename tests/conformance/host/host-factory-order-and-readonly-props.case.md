---
kind: simulation
---

# 工厂按实例顺序创建且属性只读

## 规范来源

[docs/spec/assembly.rst](../../../docs/spec/assembly.rst)

<!-- prettier-ignore -->
> 运行时 MUST 将属性作为只读快照提供，不能只依靠 TypeScript 的 readonly 注解；普通 JavaScript 赋值不能改变属性在两侧的可观察值。

<!-- prettier-ignore -->
> 根据装配结果建立全板实例资源，将各 pin 已校验的初始意图设为当前意图并建立支路；全部完成后，按 ``instances`` 列表顺序同步调用各工厂 ``create(ctx)``。

## 验收义务

前提：装配顺序为 `beta`、`alpha`，与 ID 字母序相反；两个实例都只提供 `tag`，`value` 使用默认 7；工厂尝试把 `ctx.props.value` 写为 99 后读取它。

操作：通过真实 adapter 编译模型、建立板并推进到 0。

预期：工厂调用顺序是 beta、alpha；两侧读到的 `value` 都是 7，赋值不改变可观察值；模型发送的属性值也是 7。

## 模型

<!-- prettier-ignore -->
```ddl
device HostProbe(tag: string, value: number default 7) {
  output channel out: number(capacity: 4);
  process start {
    out.send(value);
  }
}
```

## 装配

```json
{
  "instances": [
    {
      "id": "beta",
      "type": "probe",
      "props": {
        "tag": "beta"
      }
    },
    {
      "id": "alpha",
      "type": "probe",
      "props": {
        "tag": "alpha"
      }
    }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const { device, values } = await importModule('./fixture.mjs');
const observed = [];
const { board, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {
    create(ctx) {
      const before = ctx.props.value;
      try {
        ctx.props.value = 99;
      } catch {}
      observed.push([ctx.props.tag, before, ctx.props.value]);
    },
  },
  description,
);
t.after(board.dispose.bind(board));

board.runUntil(0);
```

## 断言

```typescript
assert.deepEqual(observed, [
  ['beta', 7, 7],
  ['alpha', 7, 7],
]);
assert.deepEqual(values(batches), [7, 7]);
assert.equal(board.status, 'ready');
```
