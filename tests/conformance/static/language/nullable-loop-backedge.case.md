---
format: mica-case/v1
id: language-atomic-nullable-loop-backedge
kind: compile
---

# nullable-loop-backedge

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 循环入口汇合首次进入与各回边、continue 路径的事实，出口汇合条件为假与各 break 路径的事实；仅在全部可达路径上成立的非空证明可以保留。

## 验收义务

前提：循环前排除 none，循环每轮读取后再赋 none，下一轮仍作加法。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
fn read(value: number?) -> number { let saved: number? = value; if saved == none { return 0; } while true { const copy = saved + 1; saved = none; } return 0; }
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
