---
format: mica-case/v1
id: atomic-pin-floating
kind: simulation
---

# 未参考的单引脚浮空

## 规范来源

[docs/spec/electrical.rst](../../../../docs/spec/electrical.rst)

<!-- prettier-ignore -->
> 按装配网络和当前有效电阻支路形成连通分量。分量含任意固定电位网络时具有对地参考，不要求另接地网；完全不含固定电位网络时为浮空。

## 验收义务

前提：引脚 `signal` 未列入任何网络，也没有有效电阻支路。

操作：通过真实 adapter 编译模型并推进到 0；模型同时检查采样状态、电压与电平，三者都符合浮空时输出 1。

预期：同一采样同时满足 `status` 为 `SampleStatus.floating`、`voltage` 为 `none`、`level` 为 `Logic.unknown`，唯一输出为 1。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  pin signal(low: 0.8, high: 2.0);
  process start { if signal.sample.status == SampleStatus.floating && signal.sample.voltage == none && signal.sample.level == Logic.unknown { out.send(1); } else { out.send(0); } }
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
const { device, values } = await importModule('../fixture.mjs');
const { board, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(() => board.dispose());
board.runUntil(0);
```

## 断言

```typescript
assert.deepEqual(values(batches), [1]);
```
