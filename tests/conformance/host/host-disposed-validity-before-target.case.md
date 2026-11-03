---
format: mica-case/v1
id: host-disposed-validity-before-target
kind: simulation
---

# host-disposed-validity-before-target

## 规范来源

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 已创建对象的调用守卫 MUST 依次检查 context 或对象有效性、当前阶段与同板重入、操作所需的板状态，最后才校验参数。因而 ``disposedBoard.runUntil(NaN)`` 报 ``OBJECT_DISPOSED``，``onDidError`` 回调中同板 ``runUntil('x')`` 报 ``INVALID_CALL_STATE``，均不进入参数校验。

## 验收义务

前提：真实创建的板已经销毁。

操作：对旧板调用 runUntil(NaN)。

预期：以 OBJECT_DISPOSED 拒绝，而非目标类型错误；板保持 disposed。

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
const { device, diagnostic } = await importModule('./fixture.mjs');
const { board } = await device(adapter, await adapter.compileDDL(modelSource), {}, description);
t.after(board.dispose.bind(board));
board.dispose();
```

## 断言

```typescript
assert.throws(() => board.runUntil(NaN), diagnostic('OBJECT_DISPOSED'));
assert.equal(board.status, 'disposed');
```
