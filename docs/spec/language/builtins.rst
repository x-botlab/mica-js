.. _spec-language-builtins:

================================================
内置操作
================================================

本章定义 DDL 可引用的内置名称及调用合同。普通内置函数遵循 :doc:`expressions` 的全位置或全命名实参规则，参数名称由下表固定。数值函数只接受 ``number``，不执行宿主语言的隐式类型转换。

数值与检查
------------------------------------------------

``NaN`` 和 ``Infinity`` 是内置 number 常量，负无穷写作 ``-Infinity``。它们与普通运算结果采用相同类型。

.. list-table:: 纯数值函数
   :header-rows: 1
   :widths: 45 55

   * - 签名
     - 行为
   * - ``isNaN(value: number) -> bool``
     - 判断值是否为 NaN。
   * - ``isFinite(value: number) -> bool``
     - 判断值是否有限。
   * - ``isInteger(value: number) -> bool``
     - 判断值是否为有限整数。
   * - ``isSafeInteger(value: number) -> bool``
     - 判断值是否为绝对值不超过 9007199254740991 的有限整数。
   * - ``abs(value: number) -> number``
     - 对应 JavaScript ``Math.abs``。
   * - ``floor(value: number) -> number``
     - 对应 ``Math.floor``，向负无穷取整。
   * - ``ceil(value: number) -> number``
     - 对应 ``Math.ceil``，向正无穷取整。
   * - ``trunc(value: number) -> number``
     - 对应 ``Math.trunc``，向零取整。
   * - ``round(value: number) -> number``
     - 对应 ``Math.round``，最接近整数，恰为中点时向正无穷选择；保留其负零行为。
   * - ``sqrt(value: number) -> number``
     - 对应 ``Math.sqrt``。
   * - ``min(left: number, right: number) -> number``
     - 对应两个实参的 ``Math.min``。
   * - ``max(left: number, right: number) -> number``
     - 对应两个实参的 ``Math.max``。
   * - ``pow(base: number, exponent: number) -> number``
     - 对应 ``Math.pow``，与 ``**`` 相同。

上述函数保留对应 JavaScript 数值运算的 NaN、无穷大和正负零结果。语言仅开放这些具名函数，不开放任意宿主对象或方法。

存储与字节复制
------------------------------------------------

.. list-table:: 存储操作
   :header-rows: 1
   :widths: 55 45

   * - 签名族
     - 结果与效果
   * - ``load8(memory: memory, offset: number) -> number``
     - 读取一个无符号字节，纯读取。
   * - ``load16le``、``load16be``、``load32le``、``load32be``
     - 与 ``load8`` 同样的参数名，按名称所示宽度和端序读取，纯读取。
   * - ``store8(memory: memory, offset: number, value: number)``
     - 写一个字节，无返回值。
   * - ``store16le``、``store16be``、``store32le``、``store32be``
     - 与 ``store8`` 同样的参数名，按指定宽度与端序写入。
   * - ``copyBytes(memory: memory, offset: number, length: number) -> bytes``
     - 生成指定范围的不可变字节快照，纯读取。

范围、对齐、值检查与失败完整性由 :doc:`/memory` 定义。读操作可以用于 pure fn，但读取运行时存储的调用不能进入创建期表达式。

意图与采样
------------------------------------------------

``resistor(to: pin, resistance: number) -> intent`` 是纯构造函数，目标仅接受当前实例的直接 pin 引用或 pin 形参。电阻必须有限且属于 ``[0.001, 1_000_000_000]`` Ω；构造操作执行时校验，失败属于框架错误。

``[first, second]`` 合并 intent，``[]`` 为空意图。构造不改变网络；``pin.intent <- value`` 才替换引脚贡献。完整数值、采样和错误合同见 :doc:`/electrical`。

器件通过普通供电与地引脚连接板级固定电位网络。DDL 没有内建的 ground 引用或 drive 构造；板级理想参考不进入器件资源系统。pin 之间的直接身份比较仍只比较引用，不判断装配后是否同网或等电位。

``Logic``、``SampleStatus`` 与 ``Overflow`` 为内置具名枚举。前两者的成员由 :doc:`/electrical` 维护；``Overflow`` 的成员为 ``drop_new``、``drop_oldest`` 和 ``error``，语义见 :doc:`/channels`。用户枚举采用相同的具名成员与类型身份规则。

等待与端点
------------------------------------------------

``await ticks(duration)`` 等待指定时长，完成后无值；``duration`` 是 ``number``，单位与合法性由 :doc:`/execution/index` 定义。零时长同样实际让出，在同一仿真时刻排队恢复并跨过一次电气发布边界，见 :doc:`/execution/scheduling`。``ticks`` 只在等待位置使用，不是一个可以先计算并保存的值。

``await endpoint.receive()`` 从 input channel 取得一个负载值，可以将结果丢弃。非空立即完成，空队列实际挂起。``endpoint.send(value)`` 与 ``endpoint.notify()`` 分别用于 output channel 与 output notification，均无返回值，不挂起。单消费者与批次行为由 :doc:`/channels` 定义。

``redirect(target, delay: duration)`` 为专用控制操作，目标位置是有限 number，delay 省略时为零；不能按普通函数实参混用规则解释。控制效果见 :doc:`statements`。

当前仿真时间
------------------------------------------------

``now() -> number`` 返回执行到该调用位置时的板级当前仿真时间。返回值为整数皮秒，范围与时间基准由 :doc:`/execution/index` 定义，区别于宿主系统时钟或执行耗时。同一板中不同实例在同一仿真时刻读取相同时间。

调用不推进时间、不让出执行，也不注册订阅或唤醒。同一同步片段内重复调用结果相同；实际挂起后重新调用取得恢复时刻，保存的旧时间戳仍是旧值。

now 是只读但具有时间依赖的操作，不消耗 random 的序列状态。普通 fn、process、reaction 响应体和 JIT 执行路径可调用；pure fn、derived、创建期表达式与条件等待谓词拒绝调用，效果检查沿调用图传播。读取时间不使 ``now() >= deadline`` 自动成为定时唤醒条件，定时恢复通过显式等待表达。

.. code-block:: text

   device Interval {
     process start {
       const before = now();
       await ticks(1000);
       const after = now();
       assert after - before == 1000;
     }
   }

IR 在仿真执行位置读取 now，不能在编译、Builder 构造或 JIT 翻译期间求值，优化也不能跨实际挂起复用旧读取。每块新板的时间起点为 0，运行中不由单个器件另行归零。

随机数
------------------------------------------------

``random() -> number`` 返回区间 ``[0, 1)`` 内的有限值。每个实例拥有独立随机序列；相同初始种子与调用序列得到相同结果。销毁并以等价配置创建新板时，相同实例从相同初始状态建立独立序列。

每次调用消耗序列状态，属于有状态效果。普通函数、过程、reaction 响应体和 JIT 调用路径可以使用；pure fn、derived、创建期表达式及等待谓词拒绝调用。相同调用次数以外的控制流优化不能擅自增加、删除或重排调用。

DDL 不提供重设种子的操作。确定性算法、有效初始状态及测试向量见 :doc:`/execution/random`；宿主种子配置见 :doc:`/javascript/host`，实例种子派生算法由随机章节统一规定。仿真时间读取由 now 提供，语言不提供宿主系统时钟或其他随机源读取。
