.. _spec-example-messages:

================================================
消息与存储快照
================================================

以下器件实例逐条接收 number，将值写入存储，并通过输出通道返回该值。

DDL
------------------------------------------------

.. code-block:: text

   device BufferExample {
     input channel incoming: number(capacity: 4);
     output channel outgoing: number(capacity: 4);
     output notification changed;
     public memory data[4];
     state position: number = 0;

     process start {
       loop {
         let value = await incoming.receive();
         store8(data, position, value);
         position = position + 1;
         if position == 4 {
           position = 0;
         }
         outgoing.send(value);
         changed.notify();
         await ticks(2);
       }
     }
   }

``process start`` 是本器件唯一的启动过程；接收时 FIFO 非空则立即消费，空时才挂起并在有消息时恢复。容量 4、存储长度 4、等待时长 2 ps 均为示例选择。输入按安全整数选取，以满足 ``store8`` 校验。

批次推演
------------------------------------------------

在 t=0 前，JS 依次发送 10、20、30、40，随后推进至 t=5。

* t=0、2、4 分别消费 10、20、30。
* 输出保留三条消息，各自的发送时间为 0、2、4。
* 通知合并一次，时间为 4。
* 同步点存储内容为 10、20、30、0。
* 本批未读的 40 在同步钩子调用前清理。

若同步钩子发送 50，该值属于下一批。继续推进至 t=8 时，输入在 t=5 注入，过程在 t=6 恢复并消费 50。

这次输出为时间 6、值 50 的消息，存储内容变为 10、20、30、50。已经等待的过程不从过程起点重新执行。

快照与借用
------------------------------------------------

.. code-block:: js

   function sync(batch) {
     for (const { time, value } of batch.outputs.outgoing) {
       collectMessage(time, value);
     }
     if (batch.outputs.changed !== null) {
       const snapshot = ctx.memory.data.slice();
       collectBytes(snapshot);
     }
   }

本段为工厂内片段，``collectMessage`` 和 ``collectBytes`` 是调用方提供的接收函数。``slice`` 返回调用方自有的 ``Uint8Array``，后续推进、装载或销毁不改变它。输出数组、元数据与消息值同样是可留存的只读快照；字节消息和字节属性统一使用 ``ReadonlyBytes``，精确签名见 :download:`host.d.ts <../contracts/host.d.ts>`。

``ctx.memory.data`` 是 ``BorrowedBytes``，同一句柄可在后续合法读取阶段反复读取当前内容，不是本批历史快照。其内容稳定至下一推进、销毁或对该存储成功非空装载；本例未绑定 JIT，因此只有公开读取权，不能 ``loadBytes``。销毁后句柄失效，新板独立创建 context 与句柄；自有副本及已交付消息保持内容。

通知时间不决定借用存储的历史版本；``sync`` 中借用读取反映批末最终内容。``sync`` 按装配 ``instances`` 顺序调用，本例输入 ``send`` 返回 ``void`` 并继续遵守下一批规则；阶段和故障行为见 :doc:`/javascript/host`，借用规则见 :doc:`/memory`。
