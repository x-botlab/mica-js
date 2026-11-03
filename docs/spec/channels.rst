.. _spec-channels:

================================================
通道、消息与通知
================================================

通道在配对 JavaScript 与 DDL 之间传递有类型的值，通知报告可合并的事件。运行时按推进批次注入输入、收集输出，再调用同步钩子完成交付。

本章定义已确认的通道声明、负载与交换合同，尚不表示运行时已经实现。JavaScript SDK 的精确签名见 :download:`host.d.ts <contracts/host.d.ts>`，宿主行为见 :doc:`/javascript/host`；值、声明与内置操作分别见 :doc:`/language/types`、:doc:`/language/declarations` 和 :doc:`/language/builtins`。

方向、容量与消费方
------------------------------------------------

方向以 DDL 为参照：``input`` 由 JavaScript 向 DDL 发送，``output`` 由 DDL 向 JavaScript 发送。以下为器件体内的端点声明片段：

.. code-block:: text

   input channel incoming: number(capacity: 16);
   output channel outgoing: number(capacity: 16,
                                   overflow: Overflow.drop_new);
   input notification refresh;
   output notification changed;

每个 channel 是实例独立、单消费者的有界 FIFO。容量 ``capacity`` 显式给出，单位为消息条数，MUST 在创建期求值为正安全整数。表达式可以引用 ``props``、器件常量和满足创建期限制的纯函数；求值规则见 :doc:`/language/declarations`。

输入 FIFO 的单消费者按静态过程中的 ``receive`` 位置判定：同一过程可有多个接收位置；两个不同过程接收同一通道时 MUST 拒绝，即使其分支看似互斥，也不进行互斥证明。通道可以无人消费。此项检查在调用任何器件工厂前完成。``receive`` 仅用于过程；同步函数、JIT 指令及其同步调用路径均不能接收通道消息。

同实例入口共享状态、存储和引脚，不改变单消费者约束。输出统一通过该实例的 ``sync`` 交付；钩子按装配 ``instances`` 数组顺序调用，各输出 FIFO 保持自身顺序。这一交付顺序不将不同实例的消息合并成全局时间排序。

JavaScript 使用 ``ctx.inputs.name`` 访问输入端点，使用 ``batch.outputs.name`` 接收输出。生成接口与同步钩子的统一组织见 :doc:`/javascript/interfaces`。

负载与值快照
------------------------------------------------

通道负载范围为 ``number``、``bool``、扁平记录和独立字节块。消息捕获发送时的值，资源的可变活引用不进入 FIFO。

``number`` 沿用 :doc:`/language/types` 的 IEEE 754 binary64 值域，包含 ``NaN`` 与正负无穷大；消息层不套用数值属性的有限值限制。JavaScript 对应类型为 ``number``，``bool`` 对应 JavaScript ``boolean``。

具名记录
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

.. code-block:: text

   device ItemReceiver {
     record Item {
       value: number;
       ready: bool;
     }

     input channel items: Item(capacity: 8);
   }

``record`` 是器件内部声明的具名、扁平、只读值类型，按字段比较相等。字段名唯一、全部必填，字段类型限于 ``number`` 或 ``bool``。记录不包含嵌套记录或字节块；字节块作为独立负载传递。

字段使用 ``value.field`` 读取。记录字面量由目标通道或显式注解提供期望类型；以下为该器件过程内的局部声明片段：

.. code-block:: text

   let item: Item = { value: 12, ready: true };

DDL 中缺失、重复、多余或类型不符的字段在编译时拒绝。不同名称的记录通过显式构造目标记录转换，不隐式互换。``string``、枚举和可空值可用于 DDL 内部值，但不属于通道负载范围。

JavaScript 输入使用普通对象，不要求名义标签。``send`` 同步检查必填字段与字段类型，只复制声明字段，忽略额外字段；不执行字符串转数字等隐式转换。TypeScript 对直接对象字面量的额外字段检查仍遵守自身规则。

记录与器件端点投影为生成的 TypeScript 声明，记录字段使用 ``readonly``，调用方不重复手写字段。字节长度上限仍由运行时校验。

字节块
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

.. code-block:: text

   input channel chunks: bytes(maxLength: 256, capacity: 8,
                               overflow: Overflow.drop_new);
   output channel copies: bytes(maxLength: 64, capacity: 4);

普通字节值的类型为 ``bytes``。字节通道通过 ``maxLength`` 声明每条消息的最大字节数，实际长度允许为 0 至该上限；其他负载类型的通道不能声明 ``maxLength``。``maxLength`` MUST 在创建期求值为正安全整数，与 ``capacity`` 一样可以引用 ``props`` 和器件常量。

队列容量仍按条数计量。单队列的有效载荷上限为 ``capacity * maxLength`` 字节；队列元数据、交付批次及调用方保存的历史快照另外占用空间。

字节值是只读快照，``length`` 返回实际字节数，``value[index]`` 返回 0 至 255 的 ``number``。DDL 索引 MUST 是非负安全整数且小于实际长度；非法索引报告执行错误。普通不可变 ``string`` 按 UTF-16 代码单元提供 ``length`` 和索引，同样严格检查范围；它可用于状态、派生值、参数和返回值，但不是通道负载。

字节字面量 ``bytes[expr, ...]`` 捕获不可变快照，``bytes[]`` 是合法空值。每个元素 MUST 是 0 至 255 的整数，非法值报错，不取低位或截断。需要从可变存储生成字节值时，使用 :doc:`memory` 的复制操作：

.. code-block:: text

   let chunk = copyBytes(storage, 0, length);
   copies.send(chunk);

``copyBytes(memory, offset, length)`` 复制指定范围，生成独立只读字节值。``offset`` 与 ``length`` 为非负安全整数，范围满足：

.. code-block:: text

   offset <= memory.length && length <= memory.length - offset

零长度合法，允许偏移恰等于存储长度。非法范围报错，保持源存储与通道内容不变；范围按原值检查，不采用 JavaScript ``slice`` 的负索引或截断规则。

后续存储写入不改变已复制的字节值。字节值本身不携带通道上限；向另一个通道转发时，按目标 ``maxLength`` 校验实际长度：来自上限 256 的通道、实际长度为 32 的字节值，可以发送到上限 64 的通道。

实现 MAY 合并复制与发送，或共享已有不可变字节值的存储，但 MUST 保持快照语义。

JavaScript 字节映射
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

输入 ``send`` 接受 ``Uint8Array``，在调用时复制该视图的 ``byteOffset`` 与 ``byteLength`` 所选范围。调用成功返回后，修改源视图、父数组或记录对象不影响已接纳消息。

输出字节值与字节属性统一使用 ``ReadonlyBytes``；精确成员由 :download:`host.d.ts <contracts/host.d.ts>` 定义：

.. list-table:: 输出字节快照接口
   :header-rows: 1
   :widths: 35 65

   * - 成员
     - 语义
   * - ``length`` / ``byteLength``
     - 实际字节数量。
   * - 只读索引与迭代器
     - 读取消息快照；JavaScript 越界索引读取为 ``undefined``。
   * - ``slice(start?, end?)``
     - 按 JavaScript 起止下标规则返回自有的可修改 ``Uint8Array`` 副本。

``ReadonlyBytes`` 的长度与索引均只读，索引类型为 ``number | undefined``，迭代器返回 ``IterableIterator<number>``。接口隐藏写入能力与底层 ``buffer``；后续推进、代码装载或板销毁不改变已交付快照的内容。

:doc:`memory` 的 ``BorrowedBytes`` 具有相同读取能力，但它是本板的活句柄，可跨推进重复读取当前内容，销毁后失效。需要留存借用内容的历史版本时，须在其内容稳定期内复制。跨 RPC 发送二进制数据时先取得自有副本，再通过现有 transfer hooks 传输副本。

接收、发送与校验
------------------------------------------------

.. code-block:: text

   let value = await incoming.receive();
   outgoing.send(value);
   changed.notify();

``receive`` 返回通道声明的负载类型。队列非空时立即取出最早消息；队列为空时仅挂起当前过程。立即完成的接收不结束同步片段，实际挂起则让出执行，规则见 :doc:`/execution/scheduling`。

DDL ``send`` 与 JavaScript 输入端点的 ``send`` 均返回 ``void``，只尝试入队，不等待空间，也不确认接收方已经处理。发送方需要模型级确认时，通过模型显式定义的反向消息表达。

发送 MUST 先校验类型、字段、字节范围及实际长度，再应用溢出策略。即使队列已满，非法消息仍先报告校验错误。JavaScript 输入类型错误、缺字段或字节超长时同步抛错，该次消息不入队；DDL 对应错误按执行错误处理。

溢出策略
------------------------------------------------

``overflow`` 省略时采用 ``Overflow.drop_new``。策略只适用于通过负载校验的消息。

.. list-table:: FIFO 已满时的行为
   :header-rows: 1
   :widths: 30 70

   * - 策略
     - 可观察结果
   * - ``Overflow.drop_new``
     - 丢弃本次新消息，保留已有队列。
   * - ``Overflow.drop_oldest``
     - 移除最早的一条消息，再接纳本次新消息。
   * - ``Overflow.error``
     - 本次消息不入队，立即使整板进入 ``faulted``。

``Overflow.error`` 同样适用于 DDL 输出入队与 JavaScript 暂存输入。JavaScript 即使捕获发送异常，整板故障也已经生效，不能通过捕获异常继续正常推进。

失败发送不产生部分写入，不撤销此前已经发生的状态、时间或副作用。故障发生后停止后续交付，恢复遵守 :doc:`/errors`。允许正常丢弃消息的模型使用前两种策略。

通知与时间
------------------------------------------------

notification 不携带业务负载，``notify`` 返回 ``void``。同一通知端点在一个交付批次中的多次通知合并为一次，保留最后一次通知的仿真时间。

输入通知可由 ``process name on notificationName { ... }`` 静态订阅。JavaScript 暂存的输入通知在下一批起点触发；已排队时合并，过程运行或等待期间至多记一次待再运行，不提前恢复当前等待，见 :doc:`/execution/scheduling`。

输出 FIFO 的每项为 ``{ time, value }``，``time`` 是 DDL 实际发送该消息的仿真时间，类型为 ``number``。通知输出为 ``{ time }`` 或 ``null``，后者表示本批没有该通知。

通知时间只标记事件，不携带该时刻的存储快照。例如通知时间早于 ``batch.to`` 时，``sync`` 读取公开存储获得批次结束时内容；历史内容须由模型显式保存。

批次交换
------------------------------------------------

一次正常推进按以下顺序交换数据：

#. 在批次开始注入此前 JavaScript 暂存的输入，保持各 FIFO 顺序；输入通知在推进起点触发。新板首次推进先按 :doc:`/execution/scheduling` 完成初始求解、建立观察基线并排入启动过程，再注入输入；此时尚未执行模型队列。
#. 推进仿真，执行 DDL 与动态执行入口，记录输出消息和通知。
#. 清理本批 DDL 未读输入，取出并清空输出队列和通知标记，形成交付快照。
#. 按装配 ``instances`` 数组顺序调用器件适配对象的 ``sync(batch)``，交付本批输出，并允许暂存下一批输入。

``batch.from`` 与 ``batch.to`` 是正常推进的起止仿真时间，类型为 ``number``。时间单位、范围与目标时刻处理统一遵守 :doc:`/execution/index`。同一 FIFO 的输出数组保持队列顺序，数组、消息元数据与负载作为只读快照交付。

到达目标时刻时，到期模型事件、输入事件及其反应仍按调度规则处理；该时刻不开始或恢复 JIT 执行代码，已有耗时可以到达目标，代码留待下一次更大目标推进。这个边界不能解释为所有 DDL 过程在目标时刻都暂停。通道不以全局 FIFO 顺序覆盖模型事件、阶段恢复与新指令边界之间的调度优先级。

``sync`` 中发送的输入属于下一批，MUST NOT 被本批结束清理删除。两次推进之间的输入同样暂存到下一批起点。

清理只影响尚未接收的输入。过程已经接收到局部变量中的值、挂起位置和恢复所需数据跨批次保留。因此，推进切片长度既影响外部反馈延迟，也影响一批输入能被消费的数量。

``sync`` 同步返回。异步工作在保存所需快照或副本后启动，并自行处理错误；返回 Promise 或其他 thenable 属于接口错误，运行时不等待完成，具体错误边界见 :doc:`/errors`。

失败推进与板生命周期
------------------------------------------------

以上四阶段描述正常推进。推进或交付期间发生故障时，本次调用整体失败；已发生的仿真时间、状态和外部副作用保持原样，不回滚、不自动重试。

若仿真已到目标时间而 ``sync`` 失败，时间仍停留在已到达的位置。若 A 的 ``sync`` 已完成、B 的 ``sync`` 抛错或显式报告故障，运行时停止后续处理，不调用 C 的 ``sync``。A 与 B 在失败前已产生的副作用保留，未交付输出不再补发，也不返回整次推进成功的结果。

``faulted`` 后 context 拒绝发送输入、发布话题等新增副作用；后续推进立即失败。恢复通过 ``dispose`` 销毁旧板后创建独立新板完成。销毁释放适配对象与订阅，清理旧板通道、待注入数据及通知；旧 context 与输入端点失效，新板独立创建端点。

旧异步任务的晚到结果通过旧 context 发送输入或发布话题时被拒绝，不能影响新板。旧 ``reportError`` 只作诊断；销毁后用 ``console.error`` 兜底并正常返回，不改变新板状态，见 :doc:`/errors` 与 :doc:`/javascript/host`。

已交付的数组、消息元数据、只读负载及调用方自有副本跨销毁保持内容，保存时间由持有方决定。

负载与批次合同依赖 :doc:`/language/types`、:doc:`/javascript/interfaces` 和 :doc:`/errors`。存储借用与代码装载权限分别遵守 :doc:`memory` 和 :doc:`/jit/code-memory`，消息传递不扩大它们的权限。

一致性检查
------------------------------------------------

以下为后续实现验收预期，通用方法见 :doc:`/conformance`。

* 两实例的同名通道独立；同 FIFO 保持顺序；同过程多接收位置合法，无消费者合法，跨过程接收在工厂前拒绝。
* 同步函数和 JIT 路径不能 ``receive``；所有 ``sync`` 按装配 ``instances`` 数组顺序调用。
* 容量 2 的满队列先后接纳值 1、2，再发送 3 时，``drop_new`` 保留 1、2，``drop_oldest`` 保留 2、3。
* ``Overflow.error`` 拒绝第三条消息并立即标记整板 ``faulted``；JavaScript 捕获发送异常也不能恢复正常推进。
* 类型或长度非法的新消息先于溢出策略报错，已有队列保持原样；失败前成功的状态更新继续保留。
* JavaScript 对象与子视图在发送后修改，不改变已接纳消息；子视图只复制选中范围。
* 空字节块与达到上限的字节块可以发送，超长一字节失败；来自较大上限通道的短消息可以转发至较小上限通道。
* ``props`` 参与 ``capacity`` 与 ``maxLength`` 的创建期求值；其他负载声明 ``maxLength`` 时拒绝。
* ``bytes[]`` 合法；字节字面量元素为 -1、256、小数或非有限值时失败，不采用存储写入的低位转换。
* ``copyBytes`` 后修改源存储，快照保持原内容；尾部零长度范围合法，非法范围不截断。
* DDL 字节越界索引报执行错误，JavaScript 输出快照的越界索引为 ``undefined``。
* 同批多次通知只交付一次且记录最后时间。
* 批末清除未读输入与取清输出；``sync`` 新增输入在下一批注入，已接收的局部值跨批保留。
* A 的同步交付成功、B 失败后 C 不执行；已交付副作用保留，剩余输出不补发，本次推进报告失败。
* 消息及 ``ReadonlyBytes`` 快照跨推进和销毁保持内容；旧输入端点在销毁后失效，借用句柄的读取与内容稳定期另按 :doc:`memory` 检查。
* 旧异步结果使用旧 context 发送输入或发布话题时被拒绝；销毁后 ``reportError`` 用 ``console.error`` 诊断并正常返回，不改变新板状态。
