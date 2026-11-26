.. _spec-jit:

================================================
动态执行入口
================================================

JIT 入口将实例中的代码字节按需转换为共享 IR，并通过仿真调度执行。本章中的指令是模型显式分组的执行单位，不要求仿真系统识别其领域含义。板默认使用 MCU 吞吐模式，也可选择逐指令精确模式，模式合同见 :doc:`throughput`。宿主注册与翻译回调的精确签名由 :download:`host.d.ts <../contracts/host.d.ts>` 维护，Builder 构造合同见 :doc:`/ir/builder-api`，SDK 导出布局见 :doc:`/javascript/host`。

.. toctree::
   :maxdepth: 2

   execution
   interrupts
   code-memory
   throughput

注册与绑定
------------------------------------------------

``ctx.attachJit(options)`` 在器件 JavaScript 工厂初始化期间注册本实例的具名执行入口，并返回 Disposable。注册同时由实例自动托管。

``JitHost``、``JitOptions``、``InstructionHook`` 与 ``JitTranslate`` 的成员统一引用 :download:`host.d.ts <../contracts/host.d.ts>`，避免与宿主合同重复定义。翻译边界见 :doc:`/ir/builder`；``Disposable`` 复用 ``@mica-js/core/lifecycle`` 并遵循 :doc:`/javascript/host` 的托管释放合同。

可选 ``beforeInstruction`` 仅省略时表示无钩子；``polling`` 仅省略时表示无显式轮询声明，空数组同样有效。显式 ``undefined`` 或 ``null`` 按原值校验并拒绝；选项及轮询项中的未知字段拒绝。``polling`` 的绑定和等待语义见 :doc:`throughput`；其他可选字段同样只有省略才采用默认。

``shareDirectBodies`` 仅省略时为 ``false``。启用时，运行时在同步 ``translate`` 回调期间提供 ``markDirectBodyShareable``；通过校验的标记按代码存储身份、版本、物理偏移和长度参与 Direct 指令体复用。关闭时不提供该回调，所有入口独立执行。

``directTiming`` 提供本实例的定时服务状态与安静条件；省略时只按宿主上限和其余准入条件消费标记。同步翻译期可通过 ``markDirectSpan`` 与 ``markDirectLoop`` 报告合块和循环候选；吞吐模式、主代码内存、单 JIT Direct 准入、定时状态与守卫的完整规则见 :doc:`throughput`。

``translationIdentity`` 标识生成器/融合 ABI 与时钟、特化配置，配合 ``markTranslationDependencies`` 报告的依赖字节参与跨实例翻译工件身份；复用与实例隔离规则见 :doc:`/execution/sharing`。``directTier`` 在 ``throughput`` 与既有 Direct 准入条件内生效，仅在省略时保持即时 Direct；设置正安全整数 ``promoteAfter`` 后，每个本地路由先走共享通用体，只有成功完成的真实指令计入晋升，暂停或失效的后缀、元数据刷新、轮询及折叠跳过的轮次不计数。字节写入、IR 重叠或编译上下文变化先撤销旧路由与晋升状态。

``entry`` 是本实例唯一入口名，``code`` 是本实例 memory 名称，``pc`` 是本实例 number state 名称。

名称以 ``string`` 传入，在绑定时校验存在性、资源类别和签名；执行时使用已经解析的引用。

每次注册绑定一块代码 memory 和一个位置状态，独立拥有缓存和恢复状态。

注册不执行模型操作；入口在后续 ``runUntil`` 中按普通入口规则开始执行。

一次入口注册持续到其 ``Disposable`` 释放或所属板销毁。``stop`` 永久停止当前注册的执行，但保留注册和代码装载权限；代码写入或推进不会重新启动它。释放注册取消恢复状态及等待订阅；对同一存储释放最后绑定时撤销装载权限。重新初始化通过 ``dispose`` 销毁整板后创建新板完成，新板独立建立入口与缓存。

块生成
------------------------------------------------

缓存缺失时，运行时同步调用 ``translate``，输入为当前位置和本次专用 ``BorrowedBytes`` 代码视图，由回调通过 Builder 构造一个执行块并返回 ``finish()`` 的结果。

翻译结果只能依赖位置、代码和创建时确定的配置。对运行时可变状态的判断 MUST 进入生成 IR，而非在翻译回调中提前决定。

翻译器只通过本次回调的专用代码视图读取代码，不得读取捕获的 ``ctx.memory``。专用视图仅在本次同步回调期间有效；越界索引为 ``undefined``，非法阶段或失效读取抛出 ``SimulationError``。翻译器不得留存该视图或将它作为每条指令执行时的宿主回调；``translate`` 也不允许 ``loadBytes``，阶段规则见 :doc:`/javascript/host`。

编译块是生成和缓存单位，不是原子调度单位。块可以在模型事件、电气提交、时间消费和推进边界处暂停恢复。

普通资源操作可以位于块内，按所属同步片段产生效果；模型按控制路径和等待规则结束块。

``finish()`` 结束块构造并返回 IR，不表示停止执行入口。停止入口使用指令中的 ``stop()``。

校验与错误
------------------------------------------------

绑定 MUST 验证可选条件钩子的条件为 bool 资源、处理函数为无参无返回值同步函数。``waitUntil`` 的谓词则 MUST 绑定显式声明为 ``pure fn`` 的无参 ``bool`` 函数；过程不作为函数绑定，纯函数调用图与普通函数调用图均保持无环。JIT 指令及其调用的同步函数不能 ``receive``，通道消费只由静态过程承担，见 :doc:`/channels`。

生成的 IR MUST 通过共享类型、资源和效果检查；资源引用可以访问本实例私有资源，但不越过实例边界。

翻译器意外抛错、生成无效 IR 或编译失败属于运行时故障，使本次推进失败，遵循 :doc:`/errors`。

模型预期的代码内容判断应生成相应模型行为，待其路径真正执行时生效。提前生成后续块内容本身不触发模型副作用。
