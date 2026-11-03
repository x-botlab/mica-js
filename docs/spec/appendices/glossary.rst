.. _spec-glossary:

================================================
术语
================================================

本表为正文概念提供统一名称与索引，具体行为以所链接章节为准。

.. glossary::

   DDL
      Device Description Language，描述器件资源和行为的语言。每个 UTF-8 ``.ddl`` 文件恰好包含一个 ``device``，见 :doc:`/language/index` 与 :doc:`/language/lexical`。

   共享 IR
      DDL 和 Builder 共同生成、共同校验的中间表示，见 :doc:`/ir/index`。

   Builder
      使用 TypeScript 构造共享 IR 的接口，见 :doc:`/ir/builder`。

   器件定义
      由 DeviceIR 模型和配对 JavaScript 工厂共同描述的器件类型；模型来自 DDL 或 Builder，见 :doc:`/model`。

   器件实例
      定义经属性配置创建的独立运行对象，拥有自身资源和适配对象，见 :doc:`/assembly`。

   属性
      创建时确定、在实例生命周期内保持不变的配置，也称 props，见 :doc:`/assembly`。

   板
      器件实例及网络组成的平坦装配，也称 Board，见 :doc:`/assembly`。

   资源
      具有实例归属和生命周期的对象，如 state、memory、pin 和 channel，见 :doc:`/ir/resources`。

   值快照
      捕获某一时刻的数据，后续修改源资源不改变该值，见 :doc:`/language/types`。

   bytes
      不可变字节快照值；字节通道的消息长度上限由 ``maxLength`` 配置，不属于值的类型参数，见 :doc:`/channels`。

   record
      器件内部声明的具名、扁平、只读记录值类型，字段限 ``number`` / ``bool``，按字段相等，见 :doc:`/language/types`。

   纯函数
      以 ``pure fn`` 显式声明、沿无环调用图只调用纯函数的函数；允许局部计算及授权的资源读取，保持资源只读，见 :doc:`/language/functions`。

   创建期
      资源建立与工厂调用之前，求值并校验属性、默认值、常量、资源配置和初值，再执行器件体断言的阶段，见 :doc:`/assembly`。

   电气意图
      一个 pin 当前施加的完整电气支路描述，也称 intent，见 :doc:`/electrical`。

   采样
      网络求解后发布的电压、逻辑解释与状态，也称 sample，见 :doc:`/electrical`。

   执行入口
      被运行时调度的过程或 JIT 入口；DDL 以可选且唯一的 ``process start`` 声明启动过程，其余过程显式声明 ``on source``，见 :doc:`/execution/index`。

   同步片段
      从入口开始或恢复，到实际挂起、过程结束或逻辑 JIT 指令结束的连续同步执行；ticks(0) 也结束片段，普通边界钩子返回不单独结束片段，见 :doc:`/execution/scheduling`。

   微轮
      同一仿真时刻内，由片段边界检测到的资源或采样变化引发的后续反应轮次，见 :doc:`/execution/scheduling`。

   通道
      单向、带类型、有界、单消费者的消息队列，也称 channel，见 :doc:`/channels`。

   通知
      无业务负载、可合并的端点事件，也称 notification，见 :doc:`/channels`。

   批次
      一次正常推进中的输入注入、内部执行、队列清理和同步交付过程，见 :doc:`/channels`。

   ReadonlyBytes
      字节属性与消息使用的只读值快照，内容跨后续推进和销毁保持稳定，见 :doc:`/memory`。

   借用视图
      以 BorrowedBytes 本代句柄在限定稳定期内读取实例存储的只读用途视图；句柄可复用，销毁后失效，loadBytes 可以提前结束稳定期，见 :doc:`/memory`。

   JIT 入口
      通过 attachJit 注册、按需生成共享 IR 的执行入口，见 :doc:`/jit/index`。

   指令
      JIT 模型显式分组的执行单位，可跨越多个同步片段，见 :doc:`/jit/execution`。

   编译块
      JIT 生成和缓存的单位，包含指令分组，见 :doc:`/jit/index`。

   边界钩子
      进入指令前按布尔条件调用的同步函数绑定，见 :doc:`/jit/interrupts`。

   控制转向
      redirect 结束当前 JIT 路径并在延时后重入边界的控制效果，见 :doc:`/jit/interrupts`。

   实例代次
      context、输入端点与借用句柄绑定的实例生命周期身份；销毁后失效，新建板拥有独立实例身份，旧异步任务不能影响新板，见 :doc:`/javascript/lifecycle`。

   ready
      全部工厂完成、板已交付且可推进的公开状态；首次推进才执行初始电气求解与启动过程，见 :doc:`/javascript/host`。

   faulted
      整板因首个运行时故障停止后续正常执行与交付的公开状态，保留已发生副作用；恢复须销毁旧板并创建新板，见 :doc:`/errors`。

   disposed
      板已完成尽力清理的公开终态，即使清理汇总抛错也进入该状态；再次销毁为无操作，见 :doc:`/javascript/host`。

   RuntimeDiagnostic
      包含稳定错误码、英文消息、阶段、时间、可选定位与原因、附加诊断数组的只读记录，见 :doc:`/javascript/host` 与 :doc:`/errors`。

   SimulationError
      携带主 RuntimeDiagnostic 的仿真错误；附加错误保存在主诊断的 related 数组中，见 :doc:`/javascript/host`。

   TopicBridge
      宿主 board.topics 与器件 ctx.topics 使用的同一话题接口；同步广播按注册顺序分发，宿主订阅归板、器件订阅归实例，见 :doc:`/javascript/lifecycle`。
