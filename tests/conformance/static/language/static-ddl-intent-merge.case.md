---
kind: compile
---

# static-ddl-intent-merge

## 规范来源

[docs/spec/language/builtins.rst](../../../../docs/spec/language/builtins.rst)

<!-- prettier-ignore -->
> ``[first, second]`` 合并 intent，``[]`` 为空意图。构造不改变网络；pin 声明的初值在资源建立时成为初始贡献，运行中的 ``pin.intent <- value`` 则替换引脚贡献。完整数值、采样和错误合同见 :doc:`/electrical`。

## 验收义务

前提：pin 初值以 `[first, second]` 合并两条指向不同本实例 pin 的电阻支路。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功；intent 列表合并多支路，元素按源码顺序构造。

## 输入

```ddl
device StaticFixture {
pin first;
pin second;
pin combined(low: 0.8, high: 2.0) = [
resistor(to: first, resistance: 1000),
resistor(to: second, resistance: 2000),
];
}
```

## 执行步骤

```typescript
const { validateDDL } = await importModule('../assertions.mjs');
const model = await validateDDL(adapter, input);
```

## 断言

```typescript
assert.equal(model.kind, 'device');
assert.equal(model.name, 'StaticFixture');
assert.ok(Array.isArray(model.declarations));
```
