---
kind: compile
---

# nullable-branch-join

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 收窄针对局部 const、let、函数参数及 reaction 的不可变绑定，识别 ``== none``、``!= none``、``!``、``&&``、``||`` 及提前 return、break、continue 对后续可达路径的影响。分支汇合时只保留各条可达路径共同成立的类型事实；赋值更新 let 的当前事实。match 的非空分支也收窄局部被匹配值。

## 验收义务

前提：只有 if 命中时把可空 let 写成数字，汇合后无条件相加。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
fn read(value: number?, flag: bool) -> number {
let saved: number? = value;
if flag {
saved = 1;
}
return saved + 1;
}
}
```

## 执行步骤

```typescript
const { validateDDL } = await importModule('../assertions.mjs');
const compile = () => validateDDL(adapter, input);
```

## 断言

```typescript
await assert.rejects(compile);
```
