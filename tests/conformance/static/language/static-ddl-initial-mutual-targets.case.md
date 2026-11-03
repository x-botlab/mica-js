---
format: mica-case/v1
id: static-ddl-initial-mutual-targets
kind: compile
---

# static-ddl-initial-mutual-targets

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> 引脚初始意图扩展上述创建期表达式：允许构造 ``intent`` 并引用本实例直接 pin 或经纯函数传递的 pin 形参；全部 pin 名称先绑定，因此目标可以在后面声明。引用只用于资源传参、身份比较及支路构造，不读取 ``pin.sample``。其余创建期读取与效果限制保持不变。

## 验收义务

前提：两个 pin 的初始电阻意图互相引用对方 pin。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记。

## 输入

```ddl
device StaticFixture {
pin first = [resistor(to: second, resistance: 1000)]; pin second = [resistor(to: first, resistance: 2000)];
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
assert.ok(
  model && typeof model === 'object',
  '接受两个 pin 互为初始支路目标，不误报创建期求值依赖环。',
);
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
