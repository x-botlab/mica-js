---
kind: compile
---

# static-ddl-bytes-equality-index

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 构造元素从左到右求值，每项须为 0 至 255 的整数，非法项使本次构造失败，不截断或回绕。``copyBytes(memory, offset, length)`` 从存储复制快照。``value.length`` 返回实际长度，``value[index]`` 返回字节 number。

<!-- prettier-ignore -->
> string 与 bytes 的索引均须为非负安全整数并小于实际长度，非法索引报告执行错误。两者不提供首版切片或可变数组操作。bytes 相等按长度与全部字节内容比较，不比较对象引用身份。

## 验收义务

前提：函数用 `copyBytes` 取得快照，比较两份内容相同的 bytes，并把索引结果作为 number 参与算术。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功；bytes 支持内容相等比较，索引结果为 number。

## 输入

```ddl
device StaticFixture {
memory data[4];
fn zeroHeader() -> bool {
const header = copyBytes(data, 0, 2);
return header == bytes[0, 0] && header[0] + header[1] == 0;
}
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
