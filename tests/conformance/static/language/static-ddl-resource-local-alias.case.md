---
format: mica-case/v1
id: static-ddl-resource-local-alias
kind: compile
---

# static-ddl-resource-local-alias

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 资源引用保留实例身份。只有 pin 和 memory 可作为函数资源形参，通过直接资源名或资源形参传递；不存入局部、返回、记录或可空值，channel 与 notification 也不作为形参。资源形参不是可重绑定的局部变量。pin 与 memory 的同类引用可比较身份。

## 验收义务

前提：函数试图把 pin 引用保存为局部 const。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
pin probe; fn read() { const saved = probe; }
}
```

## 执行步骤

```typescript
assert.equal(typeof adapter.compileDDL, 'function');
const compile = async () => {
  await adapter.compileDDL(input);
};
```

## 断言

```typescript
await assert.rejects(compile, '拒绝将 pin 资源保存到局部。');
```
