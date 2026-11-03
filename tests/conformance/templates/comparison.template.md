---
format: mica-case/v1
id: template-initial-intent-acceptance-comparison
kind: comparison
---

# 两种空意图声明的接受检查

复制到 `consistency/` 下并使用 `.case.md` 后缀。对照类通过一个 JSON 块组织命名输入，也可以在执行步骤中调用 Builder 构造另一条路径。两条路径各自与独立预期核对，不能仅用彼此相等代替正确性断言。一个用例说明一项明确义务；规范引用只标出处，不据此声称整段规范均已覆盖。

本例只比较编译接受和引脚声明；空意图的运行行为等价性需要另写仿真用例。

## 规范来源

[docs/spec/language/declarations.rst](../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> pin 声明可在阈值之后以 ``= expression`` 指定非可空 ``intent`` 初值；省略时为 ``[]``。

## 验收义务

前提：两个输入分别省略 pin 初值和显式写 `= []`。

操作：分别编译两个源文件并比较引脚声明。

预期：两者均被接受，引脚名称、阈值与初始意图声明相同。

## 对照输入

```json
{
  "omitted": "device EmptyIntent { pin input; }",
  "explicit": "device EmptyIntent { pin input = []; }"
}
```

## 执行步骤

```typescript
const models = [];
for (const source of [inputs.omitted, inputs.explicit]) {
  models.push(await adapter.compileDDL(source));
}
```

## 断言

```typescript
assert.equal(models.length, 2);
for (const model of models) {
  assert.equal(model.kind, 'device');
  assert.equal(model.name, 'EmptyIntent');
  const pins = model.declarations.filter((item) => item.kind === 'pin');
  assert.equal(pins.length, 1);
  assert.equal(pins[0].name, 'input');
}
```
