.. _spec-language-types:

================================================
类型与值
================================================

值保存一次计算或读取的结果，资源引用标识实例中的对象。属性、资源、形参与有值返回类型显式声明；局部绑定和器件级 const 可以从初始化表达式推断类型。

基础值
------------------------------------------------

``number`` 使用 IEEE 754 binary64，包括有限数值、NaN、正负无穷大与正负零。普通算术不随存储大小或模型位宽自动回绕。长度、地址、时长、属性等入口可施加更窄的值要求，但不创建另一套数值类型。属性 number 要求有限；时间和存储检查分别见 :doc:`/execution/index`、:doc:`/memory`。

``bool`` 仅为 ``true`` 或 ``false``。条件必须为 bool，不使用数值、字符串或资源的真假转换。

``string`` 是不可变 UTF-16 代码单元序列。字符串之间可以拼接和比较相等，不与 number 等其他类型隐式转换。``value.length`` 返回代码单元数量；``value[index]`` 返回一个代码单元构成的 string。它不按字素或 Unicode 码点索引。

枚举
------------------------------------------------

.. code-block:: text

   enum Mode { idle, active }

枚举在 device 内声明，至少一个成员，成员名唯一，使用 ``Mode.idle`` 引用。每个枚举保留具名类型身份；即使两个类型成员同名，也不能互换。成员没有公开数值编码，不提供与 number 的转换。

枚举支持同类型相等比较与 match；不支持大小排序。内置枚举使用相同规则，成员含义由 :doc:`/electrical` 和 :doc:`/channels` 维护。

可空值与收窄
------------------------------------------------

``T?`` 表示一个 T 或 ``none``，后者与零、false 和空字符串区分。T 可以自动进入 T?；需要 T 的操作先排除 none。可空标记只出现一次，资源引用和无返回类型不能可空。

.. code-block:: text

   const measured = probe.sample.voltage;
   if measured != none && measured > 0 {
     assert isFinite(measured);
   }

收窄针对局部 const、let、函数参数及 reaction 的不可变绑定，识别 ``== none``、``!= none``、``!``、``&&``、``||`` 及提前 return、break、continue 对后续可达路径的影响。分支汇合时只保留各条可达路径共同成立的类型事实；赋值更新 let 的当前事实。match 的非空分支也收窄局部被匹配值。

循环入口汇合首次进入与各回边、continue 路径的事实，出口汇合条件为假与各 break 路径的事实；仅在全部可达路径上成立的非空证明可以保留。

对每次可能变化的 state、derived 或 sample 路径读取，不沿用先前另一读取的检查；先保存到局部再检查。实际挂起不刷新已经保存的局部值。首版没有强制解包语法。

裸 ``none`` 缺少目标 T；``const x = none;`` 需要补注解，例如 ``const x: number? = none;``。条件表达式的 T 与 none 分支可以合成为 T?。

记录
------------------------------------------------

.. code-block:: text

   record Item {
     value: number;
     ready: bool;
   }

   const item: Item = { value: 12, ready: true };

记录是 device 内的具名不可变值，允许零个字段，字段名唯一、全部必填，字段类型仅为 number 或 bool。记录保持扁平。字面量从注解、实参形参、返回类型或发送目标获得期望类型；缺少该上下文时要求显式注解。

字段通过 ``value.field`` 读取。缺失、重复、多余或类型错误的字段静态拒绝。不同具名记录不隐式互换；转换时显式构造目标记录。字段不可赋值，更改内容通过构造新记录并替换允许写入的绑定实现。

同类型记录按字段比较相等，number 字段使用 :doc:`expressions` 的 NaN 规则。因此含 NaN 的记录可能不等于自身。

字节值
------------------------------------------------

``bytes`` 是独立不可变字节快照，普通类型不带长度参数。通道的 ``maxLength`` 是端点约束，发送时检查实际长度；负载及批次合同见 :doc:`/channels`。

.. code-block:: text

   const header = bytes[0x10, 0xff];
   const empty = bytes[];

构造元素从左到右求值，每项须为 0 至 255 的整数，非法项使本次构造失败，不截断或回绕。``copyBytes(memory, offset, length)`` 从存储复制快照。``value.length`` 返回实际长度，``value[index]`` 返回字节 number。

string 与 bytes 的索引均须为非负安全整数并小于实际长度，非法索引报告执行错误。两者不提供首版切片或可变数组操作。bytes 相等按长度与全部字节内容比较，不比较对象引用身份。

字节属性、消息字节和存储借用各自具有不同生命周期；前两者是可留存的值，存储借用不是 DDL 的 bytes 值，见 :doc:`/memory` 与 :doc:`/javascript/interfaces`。

意图、采样与资源
------------------------------------------------

``intent`` 是支路组合值，``sample`` 是已发布的只读采样快照。两者可以保存到局部、传参、返回或形成可空值；intent 构造与 sample 字段由 :doc:`builtins`、:doc:`/electrical` 定义。sample 按字段相等，intent 不提供相等比较；intent? 仍可与 none 比较。

资源引用保留实例身份。只有 pin 和 memory 可作为函数资源形参，通过直接资源名或资源形参传递；不存入局部、返回、记录或可空值，channel 与 notification 也不作为形参。资源形参不是可重绑定的局部变量。pin 与 memory 的同类引用可比较身份。板级理想参考不属于器件可引用的资源，供电通过普通 pin 的装配连接表达，见 :doc:`/electrical`。

类型适用范围
------------------------------------------------

.. list-table::
   :header-rows: 1
   :widths: 26 74

   * - 位置
     - 允许类型
   * - 属性
     - number、bool、string、枚举、bytes 及其可空形式。
   * - 器件级 const、state
     - number、bool、string、枚举、记录、bytes 及其可空形式。
   * - derived、局部、值形参及返回
     - 上述普通值，另加 sample、intent 及其可空形式。
   * - pin 初始意图
     - 非可空 intent；遵守创建期意图表达式限制。
   * - reaction 源及 previous / current、capture 绑定
     - number、bool、string、枚举、记录、bytes、sample 及其单层可空形式；源还须满足静态路径规则。
   * - 通道负载
     - number、bool、扁平记录、bytes；不包含可空值。
   * - 资源形参
     - pin、memory，保持引用而非复制值。

无返回值函数省略返回类型，它的调用只能用作语句。首版类型语法由这些值、资源形参和单层 T? 组成，不包含用户数组、元组、嵌套记录、函数值、显式类型转换、用户联合类型或泛型。
