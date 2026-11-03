.. _spec-language-declarations:

================================================
声明与绑定
================================================

声明为一个自包含 device 建立类型、属性、常量、实例资源和行为。文件与名称规则见 :doc:`lexical`；装配为定义绑定具体实例，关系见 :doc:`/assembly`。

器件、属性与常量
------------------------------------------------

.. code-block:: text

   device Counter(period: number default 3, capacity: number default 16) {
     const bufferLength = capacity * 2;
     assert isSafeInteger(capacity) && capacity > 0;
     assert period > 0, "period must be positive";
     memory data[bufferLength];
     state count: number = 0;
   }

``device`` 头部可以省略属性表，也可以写空括号。每个属性显式给出类型，以 ``default expression`` 指定可选默认值；没有默认值时装配必须提供。提供 none 与省略属性不同。属性在创建时确定，在实例整个生命周期内保持不变；DDL 与配对 JavaScript 读取同一补全结果。

属性类型见 :doc:`types`；number 属性仅接受有限值，额外整数、范围等条件通过 device 体内创建期 assert 检查。bytes 属性捕获输入快照，DDL 使用普通 bytes 只读操作，JavaScript 获得可留存的只读快照，见 :doc:`/assembly`。

器件级 ``const`` 使用 ``const name[: Type] = expression;``，创建时固定，不是共享可变 state。其类型可推断，但裸 none 和缺少目标类型的记录字面量需要注解。器件级常量与属性默认值可前向引用创建期依赖，图必须静态无环。

创建期表达式与顺序
------------------------------------------------

属性默认值、器件级 const、资源配置和 state 初值使用同一创建期表达式集合：字面量、属性、器件级 const、普通值运算，以及满足创建期限制的 pure fn 调用。

创建期函数调用链只能读取参数、局部、属性与器件级 const；不能读取 state、derived、pin.sample 或 memory，也不能调用 random、now 或产生资源效果。检查沿调用图传播，函数写为 pure 不能替代此处更窄的读取要求。

创建按以下顺序完成：

#. 校验提供的属性，以提供值替代相应默认值；解析默认值与器件级 const 的无环依赖。
#. 求值并校验所有资源配置和初始值。依赖必须先就绪；同等就绪的声明按源码顺序处理。
#. 按源码顺序执行创建期 assert。
#. 建立执行资源并进入 JavaScript 工厂阶段。

定义阶段即拒绝默认值或 const 的静态依赖环，不因某次实例提供了值而接受有环定义。创建期检查失败不留下可执行实例。全板检查先于工厂调用的边界继续由 :doc:`/assembly` 维护。

状态与派生值
------------------------------------------------

.. code-block:: text

   state count: number = 0;
   state enabled: bool = true;
   derived ready: bool = enabled && count > 0;

state 显式给出类型和创建期初值，写入即时生效，后续读取观察新值。同片段内其他入口不能插入；直接赋值按执行顺序后写覆盖。反应式过程在片段结束时观察最终变化，见 :doc:`/execution/scheduling`。

derived 显式给出类型和纯表达式，允许调用 pure fn。依赖可包含属性、常量、state、sample、memory 读取及其他 derived，沿函数调用图静态收集且必须无环。结果类型的适用范围见 :doc:`types`。

派生值不建立额外过程。实现可以立即重算或标脏后按需计算，读取 MUST 反映已生效依赖；sample 的发布边界保持不变。条件依赖的保守范围与订阅细则见 :doc:`/jit/interrupts`。

引脚与存储
------------------------------------------------

.. code-block:: text

   pin probe(low: 0.8, high: 2.0);
   pin reference;
   memory data[16];
   public memory exported[16];

pin 阈值与 memory 长度使用创建期表达式。pin 的 low、high 使用命名形式，必须同时给出有限且 low < high 的值，或同时省略。省略时仍采样电压与状态，但逻辑电平恒为 unknown；端点等号与完整校验见 :doc:`/electrical`。供电及地也声明为普通 pin，由装配显式连接。

memory 是实例独立固定字节区，长度允许为零。``public`` 仅修饰 memory，授予配对 JavaScript 只读用途的借用权限。初始化、范围与借用合同见 :doc:`/memory`。

通道与通知
------------------------------------------------

.. code-block:: text

   input channel incoming: number(capacity: 16);
   output channel chunks: bytes(maxLength: 256, capacity: 8,
                                overflow: Overflow.drop_new);
   input notification refresh;
   output notification changed;

方向以 DDL 为参照，声明必须显式 input 或 output。通道的 capacity 必填，overflow 可省略；bytes 通道另需 maxLength，其他负载不能带该选项。选项名不可重复，容量、上限与策略均为创建期表达式。方向、负载范围、单消费者及溢出语义见 :doc:`/channels`。

DDL 在 input channel 上 receive，在 output channel 上 send，在 output notification 上 notify；input notification 用作反应源。

函数、过程与局部绑定
------------------------------------------------

函数使用 fn 或 pure fn，过程使用可选且唯一的 ``process start``，或带 on 源路径的命名反应过程，见 :doc:`functions`。

``const`` 建立不可重赋值的局部绑定，``let`` 建立可重赋值局部，两者都要求初值：

.. code-block:: text

   const previous = count;
   let next: number = previous + 1;
   next = next + 1;

每次执行到声明时初始化；循环体的局部每轮重新初始化。局部变量属于当前调用或入口，挂起时保存所需值，不因资源更新自动刷新。参数、局部的遮蔽与可见性由 :doc:`lexical` 定义。
