.. _spec-host:

================================================
宿主接口与 SDK
================================================

本章定义器件库、板对象、宿主事件与公开模块的合同。精确 TypeScript 签名由 :download:`host.d.ts <../contracts/host.d.ts>` 维护；这些声明与示例是规范附件。器件 context 的投影见 :doc:`interfaces`，资源权限与批次分别见 :doc:`/memory`、:doc:`/channels`。

器件库
------------------------------------------------

``createDeviceLibrary(entries)`` 同步创建可复用的器件库。每项登记包含 ``id``、``model`` 与 ``create``：

* ``id`` 是板装配使用的器件类型标识，与 model.name 独立；模型名称相同不表示登记类型相同。
* ``model`` 是 :doc:`/ir/schema` 的 ``DeviceIR``，由 DDL 编译器或 Builder 产生，包含资源声明与行为 IR。
* ``create`` 是配对 JavaScript 工厂，按实例调用并返回适配对象。

库创建时 MUST 校验并捕获模型的自有内容及登记关系，拒绝重复类型标识；后续改变输入数组或模型对象不改变库。工厂保留函数引用，捕获不复制或冻结其闭包。库只持有定义，可供多个板复用，不拥有板运行资源；其生命周期由宿主引用管理。

模型校验沿用 :doc:`/ir/validation`，单消费者校验见 :doc:`/channels`。能够仅凭模型发现的冲突 MUST 在任何工厂调用前拒绝。异构库登记边界会擦除器件泛型，不能从普通 ``DeviceIR`` 自动推导工厂形参；工厂应使用对应器件生成模块的类型，或用通用 SDK 泛型精确注解其模型投影。库登记不会通过 TypeScript 反射证明工厂代码与模型相符，运行时仍只按模型提供对应资源。

核心库登记接收准备好的模型和函数。模块加载、DDL 编译及外部资源解析在调用前完成；核心创建不等待 Promise 或动态导入。

板描述与捕获
------------------------------------------------

``createBoard(library, description, options?)`` 同步装配一块板。``description.instances`` 与 ``description.nets`` 是必填的有序数组，允许为空。实例的 ``props`` 省略等同空对象，再按声明补默认值并检查必填属性。

库类型 ID、实例 ID 与网络 ID MUST 为非空字符串，按原始内容精确比较，不裁剪或规范化；实例和网络分别在自己的集合内唯一。引脚端点使用 ``{ instance, pin }``，不拼接字符串路径。``nets[].voltage`` 是可选有限电压，0 表示地，省略表示无理想参考；没有第二个 ground 字段。重复网络 ID、同网重复端点或跨网重复端点均为装配错误。电气约束见 :doc:`/electrical`。

配置对象接受普通数据对象，包括无原型的数据字典；MUST 拒绝访问器字段、自定义对象原型以及不认识的配置字段。数组、Uint8Array 和函数仅用于签名指定的位置。``props`` 的额外属性也拒绝；通道消息的额外字段仍按 :doc:`/channels` 忽略。名称查找按自有字段进行，字符串 ``__proto__`` 等不获得特殊原型行为。

创建时捕获实例、网表、属性、选项和随机初始状态。字节属性复制其视图范围，运行时不重新读取外部描述。只有省略可选字段才采用默认；显式 ``undefined`` 按非法类型处理，``null`` 仅在属性声明允许可空值时接受；创建入口将这类参数原因封装进配置失败诊断。配置文件格式、字节编码与外部资源寻址由宿主负责；重建时提供等价描述及对应器件库。执行中快照不属于本接口。

.. code-block:: typescript

   const library = createDeviceLibrary([
     { id: 'example/Node', model: nodeModel, create: createNode },
   ]);
   const board = createBoard(library, {
     instances: [{ id: 'node', type: 'example/Node' }],
     nets: [{
       id: 'reference',
       voltage: 0,
       pins: [{ instance: 'node', pin: 'reference' }],
     }],
   }, { seed: 0 });

选项与实际资源
------------------------------------------------

``seed`` 是 uint32，省略为 0。``instances[].randomState`` 可覆盖对应实例的四字初始状态；数值检查、派生算法及参考向量见 :doc:`/execution/random`。种子不读取宿主时间或随机源。

``options`` 接受 ``seed``、``execution`` 与 ``cpuQuantum``；未知字段按配置错误拒绝。``execution`` 仅接受 ``'throughput'`` 或 ``'precise'``，省略时使用 ``'throughput'``。``cpuQuantum`` 是整数 ps，合法范围为 1 到 10_000_000，省略时使用 10_000_000，即 10 μs。它限定吞吐模式引入的 CPU 可见性预算；精确模式仍校验此字段，但不使用其值。两字段均只有省略才采用默认，显式 ``undefined`` 或 ``null`` 均拒绝。模式、时间预算和轮询声明见 :doc:`/jit/throughput`。

声明数值合法不等于宿主能够分配；已知配置与资源建立错误在工厂前拒绝，建立失败报告 ``RESOURCE_ALLOCATION_FAILED``。运行中输出快照、编译缓存等资源分配失败属于框架故障，保留已发生效果，见 :doc:`/errors`。非终止调用及容器外墙钟终止的边界见 :doc:`/execution/scheduling`，它们不新增核心超时接口。

推进、故障与销毁
------------------------------------------------

板公开只读 ``time``、``status``，以及 ``runUntil(target): void`` 和 ``dispose(): void``。成功创建时 ``time`` 为 0、``status`` 为 ready；创建过程不执行模型启动过程，首次推进的初始求解见 :doc:`/execution/scheduling`。推进成功时 ``time`` 等于目标值，消息通过适配对象 ``sync`` 交付；不重复返回批次对象。

.. list-table:: 板公开状态
   :header-rows: 1
   :widths: 20 80

   * - 状态
     - 行为
   * - ready
     - 可在合法空闲阶段推进或销毁；输入和代码装载仍受各自权限约束。
   * - faulted
     - 拒绝推进及新器件副作用；保留时间与资源现场，允许读取合法借用视图和销毁。
   * - disposed
     - 资源清理已尝试完成；time、status 和已取得的诊断仍可读，重复 dispose 无操作，其余能力失效。

推进中、初始化中、事件分发中和清理中是内部调用阶段，不作为额外持久状态。每个板独立检查调用阶段，宿主在其器件回调、话题或诊断事件分发栈中不能嵌套推进或销毁同一块板；这不封锁独立板对象，但回调再次进入仍忙碌的原板时照常拒绝。

运行时 MUST 在调用副作用发生前按以下顺序检查：对象或 context 有效性；当前调用阶段及同板重入；操作需要的板状态；参数类型、数值范围及资源绑定。已销毁板的 dispose 先按幂等规则正常返回，reportError 按下文的失效兜底规则处理，其余操作调用优先报告 OBJECT_DISPOSED。因此 disposedBoard.runUntil(NaN) 不报告时间类型错误，onDidError 回调内对同板 runUntil('x') 优先报告 INVALID_CALL_STATE。故障板在空闲阶段推进报告 BOARD_FAULTED。被拒绝调用本身不改变板状态；异常逸出器件回调时仍按该回调的未捕获异常处理。

对已创建对象调用 runUntil、loadBytes 等操作时，非法类型用 TypeError；非有限或非整数的时间也属于 TypeError。负数、越界、早于当前时间的目标用 RangeError。已销毁、已故障、重入、非法阶段或绑定错误用带固定 code 的 SimulationError。库或板的创建入口统一将配置、模型及初始化失败封装为 SimulationError，底层 TypeError、RangeError 或 BuildError 保留在 cause，见下方创建失败规则。独立 IR 校验器仍按 D2 直接抛 BuildError。失败推进保留已发生的时间与状态；再次推进 faulted 板只拒绝调用，不重复发布原故障。

``dispose`` 先使全部器件 context 失效，停止新的器件分发，再按 :doc:`lifecycle` 尽力逆序清理；结束后为 disposed，即使最终需要抛出清理错误。已尝试的释放步骤不再重试。无清理错误时，销毁故障板仍正常返回；若发生清理错误，已有主故障保持主因并附加清理诊断，没有既有主故障时以首个清理错误为主因。公开接口不提供 reset，故障恢复通过销毁旧板并创建新板完成；旧 context 的有效身份不会因为实例 ID 相同而指向新板。

话题与同步事件
------------------------------------------------

``board.topics`` 与 ``ctx.topics`` 使用同一 ``TopicBridge`` 合同，支持 ``publish`` 和 ``onDidReceive``。宿主订阅归板对象所有，器件订阅归实例所有，销毁均清理；显式释放订阅遵守 at most once。广播不复制 ``unknown`` 负载，也不缓存给稍后订阅者。宿主应在取得板后发布需要全体实例接收的话题。

``TopicBridge.hostListenerCount`` 是只读的整块板计数：只统计未携带实例归属的监听者，即宿主对 ``board.topics`` 的直接订阅；实例作用域包装注册的器件监听者不计入。计数覆盖板上共享的话题分发集合，``ctx.topics`` 读到同一个值；订阅创建时增加、释放时对称减少，显式重复释放不改变计数。该值用于在无人接收时省略广播成本，监听者本身的投递不受影响。

``TopicBridge.assertCanPublish`` 按 ``publish`` 相同的顺序校验：对象有效性、当前调用阶段与板故障状态，但不复制载荷、不组装消息、不派发监听器，也不改变板状态。它只在这些条件本来就会让 ``publish`` 抛错时抛出同一 ``SimulationError``，因此调用方可以在确认无人接收时先校验再跳过复制与扇出；跳过不改变任何监听者看到的投递面。

事件采用 ``@mica-js/core/lifecycle`` 的 ``Event<T>``，订阅返回 Disposable。监听器按注册顺序同步分发，嵌套发布在返回前同步完成。单次分发沿用 Emitter 的订阅快照：当次新增监听器在下一次分发才进入快照，快照中的订阅即使中途释放仍属于当次候选；板失效或故障后的器件分发封锁优先于该候选顺序。

器件话题回调异常使板故障；宿主话题监听器异常只报告 ``HOST_LISTENER_FAILED`` 非致命诊断并继续其他监听器。运行时 MUST 包装各监听器以实现异常归属和隔离，而非依赖基础 Emitter 自动捕获异常。发布开始时的失效、非法阶段、故障状态或参数错误直接抛出；faulted 板拒绝新 publish。

合法 publish 开始后，器件监听器抛错、返回 thenable 或调用 reportError 导致的投递故障由运行时捕获：先标记 faulted，同步发布首个 onDidError，再停止后续器件分发，publish 自身正常返回，不向发布者重新抛出该投递故障。嵌套发布采用同一规则。当前 JavaScript 栈可能继续，但 context 已封锁；若发生在 sync 中，后续 sync 不再调用，当前 runUntil 最终失败。sync 按 instances 顺序调用，广播仍在当前交付栈执行，不能因此进入代码装载窗口。

错误事件与诊断
------------------------------------------------

``onDidError`` 每板仅发布一次首个整板故障。发布前先标记 faulted 并封锁器件副作用。``onDidDiagnostic`` 发布后续上报、过期上报和宿主监听器异常等非致命或附加信息；同一主故障不在两个事件中重复发布。

事件为只读通知，不自动等待监听器返回的任务。宿主监听器自行管理其异步任务及 rejection；器件钩子的 thenable 违约规则与此区分。监听器可读取 time、status、诊断并管理订阅，不能在分发栈内推进或销毁同一块板。

单个 onDidError 或宿主话题监听器抛错，不覆盖主因、不阻止其他宿主监听器与清理，通过 onDidDiagnostic 报告。onDidDiagnostic 监听器自身抛错仅用 console.error 兜底，不递归发布。销毁后的事件源不再分发；旧 context 的 reportError 用过期诊断兜底，正常返回，不改变任何新板。兜底输出失败也不能使 reportError 或清理流程再次抛错。

创建失败时尚无可交付的板对象，直接抛 SimulationError，不要求订阅创建前事件。

创建期模型表达式求值或器件体 assert 失败使用 ``MODEL_EXECUTION_FAILED``、``phase: 'assembly'``，发生于工厂调用前；底层执行或断言失败原因保留在 ``diagnostic.cause``。静态模型不合法仍使用 ``MODEL_VALIDATION_FAILED``，配置输入不合法使用 ``INVALID_CONFIGURATION``；已有专用分类码的错误继续使用专用码。断言求值为 false 是模型执行失败，不能将其归为类型或静态模型校验错误。

首次推进中建立源观察基线、运行期边界源求值、同步反应捕获或反应体中的模型求值或断言失败使用 ``MODEL_EXECUTION_FAILED``、``phase: 'execute'``，此时已创建的板进入 faulted；电气求解等已有专用分类码的错误仍使用专用码。

初始化主因保留为主诊断，清理失败按发生顺序附加。运行中首故障既触发事件，也使当前推进抛出 SimulationError；推进之外的故障立即通过事件报告。已交付诊断结构保持只读，后续附加诊断通过新事件或失败调用的汇总报告交付，不修改先前事件对象。

RuntimeDiagnostic 与 D2 的 IR Diagnostic 分开，复用 InputPath 与 SourceInfo。phase 是 library、assembly、initialize、execute、translate、sync、topic、dispose、host 或 report；time 是发生时已到达的仿真时间，在板时间尚未建立时为 null。instanceId、resource、path、source 在可确定时携带，diagnostic.cause 保留原异常引用，SimulationError 的规范访问位置为 error.diagnostic.cause，不要求 Error.cause 别名；只读合同不冻结原异常对象。related 依发生顺序保存附加诊断。

.. list-table:: 固定运行时分类码
   :header-rows: 1
   :widths: 43 57

   * - code
     - 情形
   * - INVALID_CONFIGURATION
     - 库登记、板描述、props 或 options 非法，包括重复登记或装配 ID、未知器件类型及未声明属性；存在专用分类码时使用相应专用码。
   * - MODEL_VALIDATION_FAILED
     - 库登记的 model 不满足共享 IR schema、类型、作用域或效果合同；其 BuildError 保留在 diagnostic.cause，专用通道消费者冲突使用 CHANNEL_CONSUMER_CONFLICT。
   * - RESOURCE_ALLOCATION_FAILED
     - 合法声明或运行中资源无法建立。
   * - INVALID_ELECTRICAL_PARAMETER / CONFLICTING_REFERENCE / ELECTRICAL_SOLVE_FAILED
     - 非法电气参数、参考装配冲突或数值求解失败，定位要求见 :doc:`/electrical`。
   * - CHANNEL_CONSUMER_CONFLICT
     - 不同过程可能消费同一个 input channel。
   * - INVALID_CALL_STATE / OBJECT_DISPOSED / BOARD_FAULTED / INVALID_BINDING
     - 非法阶段或重入、失效对象、故障板调用、资源绑定错误。
   * - MODEL_EXECUTION_FAILED / JIT_FAILED
     - 模型执行框架错误或 JIT 翻译、构造、绑定及编译失败。
   * - DEVICE_CALLBACK_FAILED / ASYNC_HOOK_RESULT
     - 器件同步回调抛错或返回 thenable。
   * - CHANNEL_OVERFLOW / REPORTED_ERROR / CLEANUP_FAILED
     - Overflow.error、有效 context 显式上报、释放步骤失败。
   * - STALE_REPORT / HOST_LISTENER_FAILED
     - 销毁 context 的晚到上报或宿主监听器异常。

SDK 与生成类型
------------------------------------------------

.. list-table:: 公开入口职责
   :header-rows: 1
   :widths: 42 58

   * - 入口
     - 导出职责
   * - @mica-js/simulator
     - createDeviceLibrary、createBoard、SimulationError，以及板、装配、运行时诊断类型。
   * - @mica-js/simulator/device
     - DeviceContext、DeviceBatch、DeviceFactory、DeviceAdapter、端点、话题、字节视图与 JIT 宿主接口。
   * - @mica-js/simulator/model
     - DeviceIR、BlockIR、SourceInfo、IR 校验、BuildError、类型描述及 Builder。
   * - @mica-js/simulator/ddl
     - DDL 编译工具；根入口不隐式加载 Langium。具体编译函数由编译器实现任务提供。
   * - 器件自己的生成模块
     - 从 DDL 投影的属性、端点、批次与工厂类型，引用通用 SDK，不汇总到中央 SDK。

DDL 工具从模型声明投影器件类型。仅使用 Builder 的器件可通过 DeviceContext<Props, Inputs, Memory>、DeviceBatch<Outputs> 与 DeviceFactory<Context, Batch> 注解其工厂；这些接口描述同一模型的宿主投影，不建立另一份运行时资源声明。普通 DeviceIR 不携带可供 TypeScript 从字符串资源名自动推导的泛型，注解也不替代真实模型绑定与输入校验。

事件与 Disposable 复用 ``@mica-js/core/lifecycle``；通用类型可以 type re-export，保持相同身份。开发入口的 exports 使用 source 指向源码，发布入口的 publishConfig.exports 只指向 dist，公开子路径保持一致；这些发布要求由实现任务落实，不通过本次文档修改现有包。

精确签名与验证
------------------------------------------------

.. literalinclude:: ../contracts/host.d.ts
   :language: typescript
   :linenos:

:download:`host-type-tests.ts <../contracts/host-type-tests.ts>` 检查组合接口、输入输出映射与预期类型错误，须与 :doc:`/ir/builder-api` 的现有合同测试一起运行。类型检查不能替代创建、分发、装载、销毁与错误边界的一致性执行场景，后者见 :doc:`/conformance`。仓库根目录的验证命令为：

.. code-block:: powershell

   pnpm exec tsc -p docs\spec\contracts\tsconfig.json
   node docs\spec\contracts\random-vectors.mjs
