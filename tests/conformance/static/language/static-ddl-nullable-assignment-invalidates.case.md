---
format: mica-case/v1
id: static-ddl-nullable-assignment-invalidates
kind: compile
---

# static-ddl-nullable-assignment-invalidates

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 收窄针对局部 const、let、函数参数及 reaction 的不可变绑定，识别 ``== none``、``!= none``、``!``、``&&``、``||`` 及提前 return、break、continue 对后续可达路径的影响。分支汇合时只保留各条可达路径共同成立的类型事实；赋值更新 let 的当前事实。match 的非空分支也收窄局部被匹配值。

## 验收义务

前提：let 经非空判断后被赋 none，随后用于数值运算。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
fn read(value: number?) -> number { let saved: number? = value; if saved != none { saved = none; return saved + 1; } return 0; }
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
await assert.rejects(compile, '拒绝 let 被赋 none 后沿用赋值前的非空证明。');
```
