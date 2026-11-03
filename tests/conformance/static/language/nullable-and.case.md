---
format: mica-case/v1
id: language-atomic-nullable-and
kind: compile
---

# nullable-and

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 收窄针对局部 const、let、函数参数及 reaction 的不可变绑定，识别 ``== none``、``!= none``、``!``、``&&``、``||`` 及提前 return、break、continue 对后续可达路径的影响。分支汇合时只保留各条可达路径共同成立的类型事实；赋值更新 let 的当前事实。match 的非空分支也收窄局部被匹配值。

## 验收义务

前提：可空参数先与 none 不等比较，再在 && 右侧作大小比较。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
fn read(value: number?) -> bool { return value != none && value > 0; }
}
```

## 执行步骤

```typescript
const model = await adapter.compileDDL(typeof input === 'string' ? input : input.source);
let factoryCalls = 0;
```

## 断言

```typescript
assert.equal(model.kind, 'device');
assert.equal(model.name, 'Atomic');
const library = adapter.createDeviceLibrary([
  {
    id: 'language/atomic',
    model,
    create() {
      factoryCalls++;
      return { sync() {}, dispose() {} };
    },
  },
]);
assert.ok(library);
assert.equal(factoryCalls, 0);
```
