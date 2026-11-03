.. _spec-language-functions:

================================================
函数与过程
================================================

函数封装同步行为，过程建立可由运行时调度的入口。两者使用同一套表达式、类型和实例资源，但执行效果与恢复方式不同。

同步函数
------------------------------------------------

``fn`` 声明函数，参数类型和有返回值时的返回类型显式给出：

.. code-block:: text

   fn increment(value: number) -> number {
     return value + 1;
   }

   fn advance(amount: number) {
     count = increment(count + amount);
   }

函数返回零个或一个值，记录可以作为一个返回值。无返回值函数省略返回类型，正常结束可以写 ``return;`` 或到达函数体末尾；有返回值函数的每个可正常结束路径都必须返回匹配的值。无返回值调用与取得单结果的 Builder 调用分别表达，见 :doc:`/ir/builder`。

所有形参类型显式给出，参数不可重新赋值；需要修改时先建立 let 副本。资源形参只允许 pin 与 memory，资源的使用范围见 :doc:`types`。函数仅能访问参数、自己的局部及所属 device 名称，不捕获调用者局部。函数不能作为值保存或动态调用。

首版不提供泛型、同名重载或默认函数参数。同步函数调用图必须静态无环，直接和间接递归均拒绝。重复执行通过循环表达。

一次普通函数调用同步执行到正常返回或控制转向。函数可以读取和更新其调用上下文允许访问的资源，既不创建新的调度入口，也不在函数调用边界让出执行。

普通函数不能执行会挂起的等待。需要跨时间继续的行为由 process 或 JIT 指令阶段表达；函数的同步性不因其调用者可以挂起而改变。

函数资源访问归调用它的入口。例如两个入口调用同一个更新状态的函数，它们访问同实例的同一状态，效果按各自执行片段发生。函数不是独立资源所有者，也不为共享资源建立单一写入者，见 :doc:`/execution/sharing`。

顺序过程
------------------------------------------------

``process start`` 是可选且唯一的启动过程，只在每块新板的启动阶段运行一次。启动过程从头执行，实际挂起时保存恢复位置与局部值：

.. code-block:: text

   process start {
     loop {
       advance(1);
       await ticks(period);
     }
   }

过程等待期间，其他入口可以改变共享资源。恢复时，局部值仍是等待前保存的值，新读取则遵守资源当前可见性。等待前的读、等待后的写不构成跨片段原子操作。

其他过程必须显式写 ``process name on source``；不提供 ``on start`` 形式或无 on 的任意名称入口。过程不能像 fn 一样被调用。新板启动时入口何时生效由 :doc:`/javascript/lifecycle` 和 :doc:`/execution/scheduling` 统一规定。

反应式过程
------------------------------------------------

带 ``on`` 的过程在触发源发生相应变化或通知时参与调度，例如观察引脚的逻辑采样：

.. code-block:: text

   process observe on probe.sample.level {
     if probe.sample.level == Logic.high {
       count = count + 1;
     }
   }

source 为一个静态名称或成员路径，根为本实例 state、derived、pin.sample 或 input notification，字段必须由静态类型确认；不接受调用、运算或动态索引。复杂计算先声明 derived。通知以外的源观察值变化，bool 源不自动表示仅在 true 时触发。采样源观察网络求解后发布的结果，见 :doc:`/electrical`。

反应式过程不重入，初始化仅建立观察基线。片段末按源最终值检测变化；已排队的触发合并，运行或等待期间至多记录一次待再运行，既不打断当前运行，也不提前恢复等待。过程执行时读取当前资源，具体值比较与排队规则见 :doc:`/execution/scheduling`。intent 与 intent? 不作为变化触发源。一次 ``return;`` 结束当前运行，不等于注销该入口。

同步反应
------------------------------------------------

``reaction`` 声明在已发布源值变化时执行的同步响应：

.. code-block:: text

   reaction remember on probe.sample.level as (previous, current)
     capture saved = count, header = copyBytes(data, 0, 2) {
     if previous != current {
       count = saved + 1;
       chunks.send(header);
     }
   }

``as (previous, current)`` 中的两个名称由作者指定，分别绑定相邻两次源观察的旧值与新值。``capture name = pureExpr, ...`` 整段可省略；出现时至少有一项，可带末尾逗号。reaction 与函数、过程一样只在 device 内声明，名称属于同一器件名称空间，不能作为函数调用。

source 为本实例 state、derived 或 pin.sample 起始的单一静态路径，允许访问其静态字段，最终类型必须可比较；notification 不能作为 reaction 源。调用、运算、动态索引及多个源路径均拒绝；多源观察先用 derived 构造具名扁平记录，再以该 derived 为源。比较采用 :doc:`/execution/scheduling` 的源变化规则，不用响应体内再次读取的值替代已发布源值。

previous / current 是源最终类型的不可变快照。每项 capture 从表达式推断类型，接受 number、bool、string、枚举、记录、bytes、sample 及其单层可空形式；intent、intent? 与资源引用拒绝。捕获表达式遵循现有纯表达式规则，可以读取属性、常量、state、derived、sample 和 memory，调用 pure fn；不另设更窄的读取集合。每项捕获独立求值，不能引用 previous / current、自身或其他 capture 名称。只有响应体及其词法子块可见这些绑定，辅助函数不捕获调用者绑定。名称唯一及遮蔽规则见 :doc:`lexical`。

每次发布边界按以下顺序处理 reaction：

#. 首次观察仅建立基线，不求值 capture，不执行响应体，也不合成事件；之后每次发布的变化都形成独立的一组旧值、新值和捕获快照。
#. 按稳定实例顺序及实例内声明顺序处理本轮变化，各 reaction 的 captures 按文本顺序全部求值。在任何响应体开始前，本轮所有捕获 MUST 完成。
#. 按相同稳定顺序同步执行本轮全部响应体；这些响应体之间不插入普通 process 或 JIT 恢复，也不执行新的发布边界。响应写入即时生效，后续响应的新读取可以看见写入，已捕获绑定保持不变。
#. 本轮响应全部完成后再处理下一发布边界。响应造成的源变化在下一边界形成新一轮；不能递归插入当前轮。

响应体允许普通同步效果，包括 state / memory 更新、intent 替换、output 发送与通知、now、random、assert 及同步函数调用。MUST NOT 等待、receive 或 redirect，包括经辅助函数间接产生的这些效果；return 仅结束当前响应。本轮 reaction 优先于普通过程恢复；普通 ``process ... on`` 的非重入、等待、待运行合并及读取当前值规则保持不变。reaction 不使用过程的 busy / pending 合并规则，也不把数次已发布变化压成一次当前值读取。

纯函数与条件
------------------------------------------------

``pure fn`` 显式声明纯同步函数；普通 fn 可以调用 pure fn，pure fn 只调用其他 pure fn 或纯内置操作：

.. code-block:: text

   pure fn isReady() -> bool {
     return enabled && count > 0;
   }

纯函数可以读取本实例属性、器件级 const、state、derived、pin.sample，以及 memory 的长度和内容。它可以计算记录、bytes、intent 等值，更新自己的 let、循环、断言和返回。构造 intent 本身不施加电气效果。

纯函数不能写入实例资源、替换引脚意图、访问消息队列、发送通知、等待、执行 redirect 或调用 random、now。效果检查沿调用图传播，包括短路右侧和条件分支，不能通过辅助调用绕过。创建期调用还必须满足 :doc:`declarations` 的更窄读取限制。

JIT 条件等待绑定一个无参、返回 bool 的 pure fn。derived 同样可调用 pure fn，依赖沿调用图静态收集。动态 memory 索引仍属于纯读取；条件订阅需保守覆盖可能读取的范围，不得遗漏更新。保守资源级订阅、稳定点复核及竞态处理见 :doc:`/jit/interrupts`。

随机数是有状态效果，只有普通 fn、过程、reaction 响应体和 JIT 执行路径可以调用，不能因结果类型为 number 而当作纯函数，见 :doc:`builtins`。

JIT 调用上下文
------------------------------------------------

动态 IR 可以调用已绑定的同步 DDL 函数，并与同实例其他入口共享资源。边界钩子同样归其 JIT 入口执行。

边界钩子可以直接写入绑定位置状态；写入后按普通赋值继续执行。需要终止当前路径并在延时后重新进入边界时，使用 ``redirect``。校验器不能将直接赋值当作控制转向，也不能将其一概拒绝。

可能执行 ``redirect`` 的函数带有相应控制效果，该效果沿调用图传播。它只在绑定了目标 JIT 入口的指令或边界钩子上下文中调用；缺少目标入口的路径在绑定或 IR 校验时拒绝。控制转向由运行时接管后续延时，函数本身仍同步执行到转向点。

入口注册、指令边界及代码失效分别见 :doc:`/jit/index`、:doc:`/jit/execution`、:doc:`/jit/code-memory`。

调用与验收
------------------------------------------------

普通函数调用的位置实参与命名实参不混用，且按源码顺序求值，见 :doc:`expressions`。内置控制操作 ``redirect(target, delay: duration)`` 使用独立语法，不改变普通函数调用的参数规则；其目标为位置数值参数，延时为可选命名参数，省略时为零。

签名、资源归属、返回路径及调用效果在执行前检查；不可达语句规则见 :doc:`statements`。无环调用图不证明循环终止；非终止执行由宿主隔离边界处理，语言校验与普通 assert 仍按各自合同执行。

一致性校验应比较直接调用、内联调用和 Builder 调用的可观察效果，包括同步性、共享资源归属、返回与控制转向的区别。验证归档见 :doc:`/conformance`。
