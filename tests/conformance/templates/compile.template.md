---
kind: compile
---

# 显式空意图编译

复制到 `static/language/` 或 `static/ir/` 下并使用 `.case.md` 后缀，修改唯一 ID 和实际断言。一个用例说明一项明确义务；规范引用只标出处，不据此声称整段规范均已覆盖。编译类省略模型、装配章节。

## 规范来源

[docs/spec/language/declarations.rst](../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> pin 声明可在阈值之后以 ``= expression`` 指定非可空 ``intent`` 初值；省略时为 ``[]``。

## 验收义务

前提：pin 只写显式空意图 `[]`，未给出阈值。

操作：编译源文件并检查引脚声明。

预期：编译接受该定义，引脚声明保留空意图且不引入隐含阈值。

## 输入

```ddl
device EmptyIntent {
  pin input = [];
}
```

## 执行步骤

```typescript
const model = await adapter.compileDDL(input);
const pins = model.declarations.filter((item) => item.kind === 'pin');
```

## 断言

```typescript
assert.equal(model.kind, 'device');
assert.equal(model.name, 'EmptyIntent');
assert.equal(pins.length, 1);
assert.equal(pins[0].name, 'input');
assert.equal(pins[0].low, undefined);
assert.equal(pins[0].high, undefined);
```
