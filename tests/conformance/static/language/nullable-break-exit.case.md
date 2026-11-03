---
kind: compile
---

# nullable-break-exit

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 循环入口汇合首次进入与各回边、continue 路径的事实，出口汇合条件为假与各 break 路径的事实；仅在全部可达路径上成立的非空证明可以保留。

## 验收义务

前提：loop 唯一 break 路径先证明参数非空，none 路径直接返回。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
fn read(value: number?) -> number {
loop {
if value != none {
break;
}
return 0;
}
return value + 1;
}
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
