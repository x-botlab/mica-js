---
kind: compile
---

# static-ddl-initial-missing-target

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> 引脚初始意图扩展上述创建期表达式：允许构造 ``intent`` 并引用本实例直接 pin 或经纯函数传递的 pin 形参；全部 pin 名称先绑定，因此目标可以在后面声明。引用只用于资源传参、身份比较及支路构造，不读取 ``pin.sample``。其余创建期读取与效果限制保持不变。

## 验收义务

前提：初始电阻意图的 to 参数引用未声明名称。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
pin probe = [resistor(to: missing, resistance: 1000)];
}
```

## 执行步骤

```typescript
const compile = async () => {
  await adapter.compileDDL(input);
};
```

## 断言

```typescript
await assert.rejects(compile, '拒绝初始支路目标引用不存在的 pin。');
```
