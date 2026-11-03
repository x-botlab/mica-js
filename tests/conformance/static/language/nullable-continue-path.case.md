---
format: mica-case/v1
id: language-atomic-nullable-continue-path
kind: compile
---

# nullable-continue-path

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 收窄针对局部 const、let、函数参数及 reaction 的不可变绑定，识别 ``== none``、``!= none``、``!``、``&&``、``||`` 及提前 return、break、continue 对后续可达路径的影响。分支汇合时只保留各条可达路径共同成立的类型事实；赋值更新 let 的当前事实。match 的非空分支也收窄局部被匹配值。

## 验收义务

前提：循环中参数为 none 时立即 continue，其余路径相加并 break。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
fn read(value: number?) { while true { if value == none { continue; } const next = value + 1; break; } }
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
