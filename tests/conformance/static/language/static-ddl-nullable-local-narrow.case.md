---
format: mica-case/v1
id: static-ddl-nullable-local-narrow
kind: compile
---

# static-ddl-nullable-local-narrow

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 收窄针对局部 const、let、函数参数及 reaction 的不可变绑定，识别 ``== none``、``!= none``、``!``、``&&``、``||`` 及提前 return、break、continue 对后续可达路径的影响。分支汇合时只保留各条可达路径共同成立的类型事实；赋值更新 let 的当前事实。match 的非空分支也收窄局部被匹配值。

## 验收义务

前提：参数为 number?，none 路径提前 return，剩余路径作数值运算。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记。

## 输入

```ddl
device StaticFixture {
fn valueOrZero(value: number?) -> number { if value == none { return 0; } return value + 1; }
}
```

## 执行步骤

```typescript
assert.equal(typeof adapter.compileDDL, 'function');
const model = await adapter.compileDDL(input);
let factoryCalls = 0;
```

## 断言

```typescript
assert.ok(model && typeof model === 'object', '接受局部参数排除 none 后提前返回建立的非空证明。');
assert.equal(model.kind, 'device');
assert.equal(model.name, 'StaticFixture');
assert.ok(Array.isArray(model.declarations));
const library = adapter.createDeviceLibrary([
  {
    id: 'static/fixture',
    model,
    create() {
      factoryCalls++;
      return { sync() {}, dispose() {} };
    },
  },
]);
assert.ok(library && typeof library === 'object');
assert.equal(factoryCalls, 0, 'Library registration must not invoke factories');
```
