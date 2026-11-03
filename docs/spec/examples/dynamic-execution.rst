.. _spec-example-dynamic:

================================================
动态执行块
================================================

本例以字节决定一次状态更新的常量参数，用一个简单映射展示 JavaScript 生成 IR、运行时执行 IR 的分工。DDL、Builder 与宿主接口均按已确认合同编写，尚不表示 SDK 或运行时已经实现。宿主精确签名引用 :download:`host.d.ts <../contracts/host.d.ts>`，行为主定义见 :doc:`/javascript/host`。

实例资源
------------------------------------------------

.. code-block:: text

   device DynamicExample {
     memory code[3];
     state position: number = 0;
     state total: number = 0;

     fn update(value: number) {
       total = total + value;
     }
   }

JavaScript 工厂
------------------------------------------------

.. code-block:: js

   export default function create(ctx) {
     ctx.attachJit({
       entry: 'execute',
       code: 'code',
       pc: 'position',
       translate({ pc, code }, builder) {
         const value = code[pc];
         builder.instruction({ pc, nextPc: pc + 1 }, instruction => {
           if (value === 0) {
             instruction.stop();
           } else {
             instruction.call('update', value);
             instruction.elapse(1);
           }
         });
         return builder.finish();
       },
     });
     ctx.loadBytes('code', Uint8Array.of(1, 2, 0));
     return {
       sync() {},
       dispose() {},
     };
   }

此工厂只用于已经装入的三个字节，且位置按该映射顺序推进。通用实现还需为所有可到达位置校验范围，并对模型预期的无效内容生成相应执行路径。

工厂先 ``attachJit`` 建立装载授权，再 ``loadBytes`` 复制源视图选中的字节；省略偏移时采用 0，显式 ``undefined`` 或 ``null`` 不等同于省略。``code`` 未公开，但注册绑定允许装载；``public`` 本身不授予写入。注册的 JIT 由实例自动托管；本例没有额外外部资源，所以适配对象的 ``dispose`` 为空，销毁整板仍会释放注册。

``translate`` 只读取本次专用 ``code`` 视图，不能改读捕获的 ``ctx.memory``，也不能调用 ``loadBytes``；视图只在本次翻译回调有效。``update`` 是运行时同步函数，状态更新通过生成 IR 调用，不通过 JavaScript context 直接访问 ``state``。

执行推演
------------------------------------------------

* 初始化时，位置和总数均为 0；注册、装载不执行 ``update``。
* 推进目标大于 0 时，从位置 0 开始，将位置预置为 1，再使总数增加 1，然后消费 1 ps。
* 若目标恰好为 1，运行时停在 t=1，不开始位置 1 的指令。
* 继续推进至大于 1 的目标时，位置预置为 2，总数增加 2，再消费 1 ps。
* 目标大于 2 时，位置 2 的分组执行停止，总数为 3。

每次 Builder 回调产生 IR 时，``update`` 尚未执行。其状态副作用只发生在对应指令的运行阶段。

停止后的注册保留装载权限，在 ``idle`` 中再次装载代码也不重启该入口；释放最后绑定才撤销该存储的装载权限。``sync`` 及其嵌套话题回调、翻译和清理中装载均被拒绝。要重新执行初始模型，先 ``dispose`` 销毁旧板，再创建新板；新板独立初始化状态、代码和缓存，旧 context 不能影响它。

改变块长度或内联 ``update``，必须保持上述顺序、时间和终点结果，以及各逻辑边界的同步反应闭包，见 :doc:`/jit/execution` 与 :doc:`/execution/scheduling`。
