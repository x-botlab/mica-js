---
kind: compile
---

# static-ddl-ticks-named-duration

## 规范来源

[docs/spec/appendices/grammar.rst](../../../../docs/spec/appendices/grammar.rst)

<!-- prettier-ignore -->
> await-statement = await-operation, ";" ;
>    await-operation = "await", "ticks", "(", tick-argument, [ "," ], ")" ;
>    tick-argument = expression | "duration", ":", expression ;

## 验收义务

前提：过程分别以命名形式 `duration: 1` 与带末尾逗号的位置形式等待 ticks。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功；`duration` 命名标签与时长位置的末尾逗号均为合法等待形式。

## 输入

```ddl
device StaticFixture {
process start {
await ticks(duration: 1);
await ticks(0,);
}
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
