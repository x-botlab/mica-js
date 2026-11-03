---
kind: comparison
---

# consistency-manual-ir-and-ddl-share-execution

## 规范来源

[docs/spec/ir/validation.rst](../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> DDL、Builder 与手工 IR 输入共享校验规则。TypeScript 类型检查提供构造期辅助，执行前仍 MUST 核对结构、类型、引用、控制流与效果。两种来源不会获得不同的资源权限。

[docs/spec/conformance.rst](../../../docs/spec/conformance.rst)

<!-- prettier-ignore -->
> 对同一组输入，比较正常完成或报告模型错误的 DDL 路径、等价 Builder 路径及不同优化配置的状态、时间、消息和模型错误位置。

## 验收义务

前提：同一个“写入 data[0]=1，读取并保存，写 data[0]=9，再把保存值写入 data[1] 并发送”的过程分别以手工 DeviceIR 与 DDL 描述。

操作：把两个模型登记为不同 ID，装配到同一块板并推进到 0。

预期：两个实例的公开 memory data 都是 [9,1,0]，各自输出通道都收到一次值 1。

## 对照输入

```json
{
  "source": "device ManualParity {\n  public memory data[3];\n  output channel out: number(capacity: 32);\n  process start {\n    store8(data, 0, 1);\n    let saved: number = load8(data, 0);\n    store8(data, 0, 9);\n    store8(data, 1, saved);\n    out.send(saved);\n  }\n}",
  "manual": {
    "kind": "device",
    "name": "ManualParityIR",
    "declarations": [
      {
        "kind": "memory",
        "name": "data",
        "public": true,
        "length": {
          "type": {
            "kind": "number"
          },
          "body": {
            "operations": [
              {
                "kind": "constant",
                "result": 0,
                "type": {
                  "kind": "number"
                },
                "constant": {
                  "kind": "number",
                  "value": 3
                }
              },
              {
                "kind": "returnValue",
                "value": 0
              }
            ]
          }
        }
      },
      {
        "kind": "channel",
        "name": "out",
        "direction": "output",
        "type": {
          "kind": "number"
        },
        "capacity": {
          "type": {
            "kind": "number"
          },
          "body": {
            "operations": [
              {
                "kind": "constant",
                "result": 0,
                "type": {
                  "kind": "number"
                },
                "constant": {
                  "kind": "number",
                  "value": 32
                }
              },
              {
                "kind": "returnValue",
                "value": 0
              }
            ]
          }
        }
      },
      {
        "kind": "start",
        "body": {
          "operations": [
            {
              "kind": "constant",
              "result": 0,
              "type": {
                "kind": "number"
              },
              "constant": {
                "kind": "number",
                "value": 1
              }
            },
            {
              "kind": "constant",
              "result": 1,
              "type": {
                "kind": "number"
              },
              "constant": {
                "kind": "number",
                "value": 0
              }
            },
            {
              "kind": "store8",
              "memory": {
                "kind": "memory",
                "name": "data"
              },
              "offset": 1,
              "value": 0
            },
            {
              "kind": "load8",
              "result": 2,
              "type": {
                "kind": "number"
              },
              "memory": {
                "kind": "memory",
                "name": "data"
              },
              "offset": 1
            },
            {
              "kind": "constant",
              "result": 3,
              "type": {
                "kind": "number"
              },
              "constant": {
                "kind": "number",
                "value": 9
              }
            },
            {
              "kind": "store8",
              "memory": {
                "kind": "memory",
                "name": "data"
              },
              "offset": 1,
              "value": 3
            },
            {
              "kind": "store8",
              "memory": {
                "kind": "memory",
                "name": "data"
              },
              "offset": 0,
              "value": 2
            },
            {
              "kind": "send",
              "channel": "out",
              "value": 2
            }
          ]
        }
      }
    ]
  }
}
```

## 执行步骤

```typescript
const compiled = await adapter.compileDDL(inputs.source);
const output = { manual: [], ddl: [] };
const contexts = {};
const library = adapter.createDeviceLibrary(
  [
    ['manual', inputs.manual],
    ['ddl', compiled],
  ].map(([id, model]) => ({
    id,
    model,
    create(ctx) {
      contexts[id] = ctx;
      return {
        sync(batch) {
          if (batch.outputs.out)
            output[id].push(...batch.outputs.out.map((message) => message.value));
        },
        dispose() {},
      };
    },
  })),
);
const board = adapter.createBoard(library, {
  instances: [
    { id: 'manual', type: 'manual' },
    { id: 'ddl', type: 'ddl' },
  ],
  nets: [],
});
t.after(board.dispose.bind(board));
board.runUntil(0);
```

## 断言

```typescript
assert.deepEqual([...contexts.manual.memory.data], [9, 1, 0]);
assert.deepEqual([...contexts.ddl.memory.data], [9, 1, 0]);
assert.deepEqual(output.manual, [1]);
assert.deepEqual(output.ddl, [1]);
```
