================================================
接口与类型投影
================================================

本章定义器件 JavaScript 的类型投影与数据所有权。接口已经确认，尚未实现；精确 SDK 合同统一维护于 :download:`host.d.ts <../contracts/host.d.ts>`，宿主行为主定义见 :doc:`host`。属性行为由 :doc:`/assembly` 定义，FIFO、通知与批次规则由 :doc:`/channels` 定义，错误由 :doc:`/errors` 与 :doc:`host` 统一规定。

通用类型的定义来源
------------------------------------------------

精确字段和泛型签名以类型附件为单一来源；本文解释生成投影，不重复声明通用接口。SDK 公开入口按以下职责组织：

.. list-table:: SDK 入口
   :header-rows: 1
   :widths: 25 75

   * - 入口
     - 内容
   * - SDK 根入口
     - Board 与 library；器件库登记的 ``model`` 字段为 ``DeviceIR``。
   * - ``/device``
     - 器件侧通用 context、工厂、适配对象、端点、批次、话题、字节视图及 JIT 宿主类型。
   * - ``/model``
     - 共享 IR 与 Builder；精确签名分别见 :download:`ir.d.ts <../contracts/ir.d.ts>` 和 :download:`builder.d.ts <../contracts/builder.d.ts>`。
   * - ``/ddl``
     - 隔离的 DDL 编译入口。
   * - 生成器件模块
     - 该器件的属性、context、批次及工厂等生成类型。

宿主类型附件可以重导出根入口和 ``/device`` 的引用。调用方从所属公开入口或器件模块导入，不通过重复手写类型维持两套合同。

工厂、端点与话题
------------------------------------------------

``DeviceFactory``、``DeviceAdapter``、``InputChannel``、``InputNotification``、消息元数据和 ``TopicBridge`` 均引用 :download:`host.d.ts <../contracts/host.d.ts>`。``InputChannel.send`` 与 ``InputNotification.notify`` 返回 ``void``，只暂存下一批输入；``sync`` 是输出统一交付入口。器件工厂、``sync``、器件话题回调和 ``dispose`` 的同步返回约束见 :doc:`host` 与 :doc:`lifecycle`。

``TopicBridge.onDidReceive`` 使用 ``@mica-js/core/lifecycle`` 的真实 ``Event<T>``，订阅返回同一体系的 ``Disposable``。``board.topics`` 与器件 ``ctx.topics`` 使用同一 bridge；话题 ``payload`` 为 ``unknown`` 并按原引用传递，不复制。事件本轮使用注册快照：新增监听从下一轮生效，已在快照中的监听即使中途释放仍在本轮调用；整板 ``faulted`` 时停止器件分发的规则优先，销毁后不再分发事件。

核心 ``Emitter.fire`` 的监听异常会中止本轮调用；需要监听异常隔离的分发 MUST 由运行时包装监听函数实现，不能依赖核心 Emitter 自动隔离。合法 ``publish`` 在 ``ready`` 时开始投递后，器件监听器异常、thenable 返回或 ``reportError`` 使板先 ``faulted`` 并同步分发首个 ``onDidError``，停止后续器件分发；该 ``publish`` 正常返回，不重抛已捕获的器件异常，嵌套发布同样适用。发布者自身的调用错误与故障后新发布仍抛出。话题回调的异常归属、故障封锁和清理规则以 :doc:`host` 为准。

公开调用按 context 或对象有效性、当前阶段与同板重入、所需板状态、参数的顺序校验；已销毁板的 ``dispose`` 优先无操作返回，旧 ``reportError`` 保持诊断特例。分发栈内的推进与销毁封锁只限同板，不妨碍回调操作满足自身守卫的独立板，见 :doc:`host`。

所有 ``time``、``from``、``to`` 的数值表示、单位、范围与目标时间语义均以 :doc:`/execution/index` 为单一来源。

context 由 ``props``、``inputs``、``memory``、``topics``、``reportError`` 与 ``JitHost`` 组成，不是任意访问 DDL ``state`` 的 SDK。``faulted`` 或失效 context 拒绝输入、发布和装载等新增副作用；旧 ``reportError`` 只作诊断，销毁后使用 ``console.error`` 兜底且正常返回。错误与诊断主定义见 :doc:`/errors` 和 :doc:`host`。

端点投影
------------------------------------------------

.. list-table:: DDL 声明到 JavaScript 的对应关系
   :header-rows: 1
   :widths: 45 55

   * - DDL 侧对象
     - JavaScript 侧位置
   * - 输入 channel ``request``
     - ``ctx.inputs.request.send(value)``
   * - 输入 notification ``refresh``
     - ``ctx.inputs.refresh.notify()``
   * - 输出 channel ``result``
     - ``batch.outputs.result``
   * - 输出 notification ``changed``
     - ``batch.outputs.changed``
   * - ``public memory values``
     - ``ctx.memory.values``，只读用途的借用视图。
   * - 属性 ``count``
     - ``ctx.props.count``，创建时确定的固定值。

方向以 DDL 为参照：input 为 JavaScript 向 DDL 发送，output 为 DDL 向 JavaScript 交付。context 只公开输入发送端点，输出集中进入 ``sync(batch)``。

器件生成器根据 DDL 声明导出具体属性、输入、公开存储、输出批次和工厂类型，并组合 ``/device`` 通用类型。``public`` 只授予存储借用读取；私有资源的 JIT 绑定按 :doc:`/jit/index` 单独校验。

输出数组保持各自 FIFO 顺序；``time`` 是 DDL 实际发送的仿真时间。通知输出为最后一次通知的 ``{ time }``，本批无通知时为 ``null``。``from`` 与 ``to`` 标识本次正常推进的起止时间。所有 ``sync`` 按装配 ``instances`` 数组顺序调用；调用失败不产生整次推进成功的结果，部分交付见 :doc:`/errors`。

可选字段仅省略时采用默认值，显式 ``undefined`` 或 ``null`` 均按原值校验；只有目标语言类型允许可空时 ``null`` 才合法。装配 ``instances`` 与 ``nets`` 必填，但允许空数组；省略 ``props`` 时采用空对象。完整参数校验规则见 :doc:`host`。

借用字节与快照
------------------------------------------------

``BorrowedBytes`` 与 ``ReadonlyBytes`` 的精确成员引用 :download:`host.d.ts <../contracts/host.d.ts>`。两者均有只读 ``length``、``byteLength``、结果为 ``number | undefined`` 的数值索引、``[Symbol.iterator](): IterableIterator<number>`` 与返回自有 ``Uint8Array`` 的 ``slice(start?, end?)``；越界索引为 ``undefined``，``slice`` 使用 JavaScript 下标规则，均不暴露 ``buffer`` 或写入。

以下比较 context 数据的生命周期；借用读取阶段、稳定期及装载权限的完整规则以 :doc:`/memory` 和 :doc:`host` 为准。

.. list-table:: 三类字节数据的所有权
   :header-rows: 1
   :widths: 22 38 40

   * - 数据
     - 捕获或有效边界
     - 留存方式
   * - ``ReadonlyBytes`` 字节属性
     - 创建时捕获，销毁后仍保持内容。
     - 可直接留存，见 :doc:`/assembly`。
   * - 公开存储的 ``BorrowedBytes``
     - 本板未销毁时句柄可复用；内容稳定至下一推进、销毁或同存储成功非空装载。
     - 跨推进可读当前内容；保存历史内容须在稳定期内复制。
   * - ``ReadonlyBytes`` 消息快照
     - 发送时捕获；后续推进、装载或销毁不改变已交付内容。
     - 可直接留存，见 :doc:`/channels`。

FIFO 数组、消息元数据及消息值都是可留存的只读批次快照。``slice`` 返回调用方拥有的可变 ``Uint8Array`` 副本；跨边界二进制传输使用该副本与现有 transfer hooks，不转移借用存储。

消息与属性映射
------------------------------------------------

消息负载范围为 ``number``、``bool``、扁平记录和独立 ``bytes`` 值。记录在 ``device`` 内部具名声明，字段为数值或布尔值；记录不嵌套，也不包含字节块。``string``、枚举及可空值可用于语言内部，但不进入 channel。类型归属见 :doc:`/language/types`，通道语法和 ``copyBytes`` 规则见 :doc:`/channels`。

* 数值与布尔值分别映射为 ``number`` 与 ``boolean``；普通数值消息包含 ``NaN`` 和正负无穷大，数值属性则仅接受有限值。
* 记录投影为只读字段接口；输入按声明字段校验和复制，额外字段忽略，不做隐式类型转换。
* JavaScript 字节输入为 ``Uint8Array``，``send`` 时仅复制该视图选中的范围。
* 字节属性与字节输出统一映射为可留存的 ``ReadonlyBytes``；输入发送仍接收 ``Uint8Array``。

输入 ``send`` 同步检查字段、类型与实际字节长度，失败立即抛错且不入队；有效消息再进入 :doc:`/channels` 的溢出处理。发送返回后修改原对象或原视图不改变已接纳消息；字节上限由目标 channel 的 ``maxLength`` 在运行时检查，普通 ``bytes`` 类型本身不携带上限，TypeScript 接口不代替运行时校验。

只读批次数组、元数据、记录和字节快照均可跨推进及销毁留存。借用句柄读取遵守本实例工厂初始化、``idle``、``sync`` 的阶段限制，``faulted`` 未销毁可读现场，非法阶段或失效读取抛出 ``SimulationError``；``translate`` 只读取本次专用代码视图。
