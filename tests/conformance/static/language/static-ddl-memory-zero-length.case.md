---
kind: compile
---

# static-ddl-memory-zero-length

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> memory 是实例独立固定字节区，长度允许为零。``public`` 仅修饰 memory，授予配对 JavaScript 只读用途的借用权限。初始化、范围与借用合同见 :doc:`/memory`。

[docs/spec/memory.rst](../../../../docs/spec/memory.rst)

<!-- prettier-ignore -->
> 长度的单位为字节，类型统一为 ``number``。长度 MUST 在创建期求值为非负安全整数，允许为零。表达式可以引用 ``props``、器件常量及满足创建期限制的纯函数，实例生命周期内属性与存储长度保持不变。

## 验收义务

前提：memory 长度以字面量 0 声明。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功；零长度 memory 属于合法固定字节区。

## 输入

```ddl
device StaticFixture {
memory empty[0];
public memory emptyPublic[0];
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
