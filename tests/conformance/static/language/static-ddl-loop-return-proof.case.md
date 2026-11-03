---
format: mica-case/v1
id: static-ddl-loop-return-proof
kind: compile
---

# static-ddl-loop-return-proof

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> return、break、continue、redirect 后继续追加同路径语句属于静态错误。if 或 match 全部分支终结时，外层路径也终结。没有可达 break 的 loop 不形成正常结束路径；while 不通过一般常量计算证明其必然进入或不结束。

## 验收义务

前提：有返回值函数只包含没有 break 的 loop。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记。

## 输入

```ddl
device StaticFixture {
fn read() -> number { loop { continue; } }
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
assert.ok(model && typeof model === 'object', '接受无可达 break 的 loop 不形成正常结束路径。');
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
