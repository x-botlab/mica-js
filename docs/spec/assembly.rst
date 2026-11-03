================================================
板级装配与属性
================================================

本章细化 :doc:`/model` 的器件定义、实例与板模型，规定装配输入、静态校验和创建顺序。规范用语见 :doc:`/introduction`。

器件库与类型标识
------------------------------------------------

器件是装配的最小单元。板由平坦的实例集合与网络集合组成；器件定义中不嵌套子器件实例。

器件库 MUST 显式登记每个器件类型标识所对应的 DeviceIR 模型与 JavaScript 工厂，模型可由 DDL 或 Builder 产生。每种器件都需要工厂，包括无需额外初始化工作的器件；工厂的最小返回形态见 :doc:`/javascript/interfaces`。

器件类型标识是装配使用的字符串，与 model.name 独立；同一模型可在不同标识下登记，不同登记也可具有相同模型名称。同一器件类型标识重复登记属于错误。模型来自 DDL 时，一个 UTF-8 ``.ddl`` 文件恰好声明一个 ``device``，其声明名称成为模型名称；文件名和显示名称不参与自动配对。DDL 的枚举、记录和函数均在器件内部声明，不通过跨文件导入复用；JavaScript 模块加载与器件库登记属于宿主接口。

同一定义的模型及编译结果可以复用；每个实例独立拥有状态、存储、通道与适配对象。JavaScript 模块可以共享加载结果，实例状态在各自工厂调用中建立。

``createDeviceLibrary`` 登记准备好的器件模型 IR 与工厂；模型可来自 DDL 或 Builder。具体签名、捕获和模块准备边界见 :doc:`/javascript/host`：

.. code-block:: typescript

   const library = createDeviceLibrary([
     { id: 'example/ValueSource', model: sourceModel, create: createValueSource },
     { id: 'example/ValueSink', model: sinkModel, create: createValueSink },
   ]);

板级描述
------------------------------------------------

装配输入使用 ``instances`` 与 ``nets`` 两个必填有序数组，允许空数组。精确类型与配置校验见 :doc:`/javascript/host`。

.. list-table:: 板级数据
   :header-rows: 1
   :widths: 25 75

   * - 数据
     - 内容与约束
   * - ``instances``
     - 有序实例列表；每项包含板内唯一且稳定的实例 ID、器件类型标识与 ``props``。
   * - ``nets``
     - 网络列表；每项包含网络 ID、具名引脚端点及可选固定电位约束。端点由实例 ID 与 DDL 引脚名共同定位。地网固定 0 V，理想电源网固定为给定的有限对地电压。

未列入网络的引脚保持未连接。同网重复端点、同一引脚分配到不同网络或重复网络 ID 均属于装配错误。参考约束必须显式给出，不根据名称自动连接。电压允许为负，在板创建时捕获并固定；每网至多一个 ``voltage`` 字段，重复网络描述不能用于叠加参考。理想参考不需要器件或工厂，器件通过接入网络的普通 pin 取电，不能直接引用板级参考。

电源网与地网之间允许通过器件电阻相连，各自仍保持固定电位。含任一固定电位的电阻连通分量即具有参考，不要求额外地线；缺少参考时发布 floating，不因为某引脚名为 VCC 或 GND 而自动报漏接错误。完整求解合同见 :doc:`/electrical`。

``voltage`` 统一表示固定电位，0 表示地。端点使用实例 ID 和引脚名的对象；示例中的类型、属性与引脚须由对应器件定义提供：

.. code-block:: typescript

   const boardDescription = {
     instances: [
       { id: "source", type: "example/ValueSource", props: { level: 1 } },
       { id: "sink", type: "example/ValueSink", props: { label: null } },
     ],
     nets: [
       { id: "link", pins: [{ instance: "source", pin: "out" }, { instance: "sink", pin: "sample" }] },
       { id: "supply", voltage: 3.3, pins: [{ instance: "source", pin: "supply" }] },
       { id: "reference", voltage: 0, pins: [{ instance: "source", pin: "reference" }] },
     ],
   };

装配由器件定义与网表直接生成装配 IR，再编译板级执行代码并复用配对工厂。板级连接与实例配置使用结构化装配输入；``.ddl`` 文件描述单个器件定义，不承载板级实例集合。

属性的值与生命周期
------------------------------------------------

属性统一称为 ``props``，在 ``device`` 头部声明类型，以 ``default`` 指定可选默认值；没有默认值的属性必须由装配输入提供。属性在创建实例时确定，在该实例整个生命周期内 MUST 保持不变。销毁后创建的是独立新板，不能通过旧实例接口修改属性，生命周期见 :doc:`/javascript/lifecycle`。

装配 MUST 对属性完成校验和默认值补全。模型执行与 ``ctx.props`` 读取同一份补全结果。运行时 MUST 将属性作为只读快照提供，不能只依靠 TypeScript 的 readonly 注解；普通 JavaScript 赋值不能改变属性在两侧的可观察值。普通函数的实参仍称参数，与实例属性区分。

.. list-table:: 属性类型及 JavaScript 值
   :header-rows: 1
   :widths: 20 35 45

   * - DDL 类型
     - JavaScript 表示
     - 校验与含义
   * - ``number``
     - ``number``
     - 接受有限数值；整数、正数等要求通过器件体创建期 ``assert`` 校验。
   * - ``bool``
     - ``boolean``
     - 接受布尔值。
   * - ``string``
     - ``string``
     - 接受字符串。
   * - 具名枚举
     - 枚举成员名字符串
     - 按 DDL 枚举声明校验；具名枚举没有数值编码或数值转换。
   * - ``T?``
     - 对应类型的值或 ``null``
     - ``null`` 对应 DDL 的 ``none``。
   * - ``bytes``
     - 装配输入为 ``Uint8Array``
     - 装配捕获可留存的 ReadonlyBytes 快照，成员与签名见 :doc:`/javascript/host`。

属性类型为 ``number``、``bool``、``string``、具名枚举、``bytes`` 及这些类型的可空形式。省略属性时使用声明的默认值；没有默认值则报告缺少必填属性。显式 ``null`` 是提供可空值，并非省略。枚举、可空值及数值的一般类型规则见 :doc:`/language/types`。

``bytes`` 属性是静态输入，与运行时可变的 ``memory`` 区分。装配 MUST 捕获输入字节快照，使调用方随后修改原始数组不影响实例。DDL 和配对 JavaScript 使用这份固定内容，ReadonlyBytes 快照可跨推进和销毁留存；``slice`` 返回调用方拥有的 Uint8Array 副本，不暴露可写底层 buffer。

属性快照、消息快照与借用视图的用途不同，接口侧比较见 :doc:`/javascript/interfaces`。将静态字节内容复制到运行时资源时，仍需遵守 :doc:`/memory` 与 :doc:`/jit/code-memory` 的受控写入契约。

装配顺序
------------------------------------------------

运行时 MUST 按以下顺序完成一次装配：

#. 在创建前异步准备器件模块、DDL 和属性引用的外部资源，将资源解析为实际属性值。
#. 完成全板静态校验与属性补全，包括类型登记、实例 ID、属性、实例引用、引脚名、跨网络重复引脚，以及固定电位的有限性与同网约束一致性；绑定各实例全部 pin 名称，校验初始意图引用的类别与实例归属；求值并校验默认值、器件常量、资源配置、``state`` 初值及 pin 初始意图，pin 阈值须同时省略或同时给出有限且 low < high 的值。
#. 对全板各实例执行器件体创建期 ``assert``，全部通过后才进入资源建立阶段。
#. 根据装配结果建立全板实例资源，将各 pin 已校验的初始意图设为当前意图并建立支路；全部完成后，按 ``instances`` 列表顺序同步调用各工厂 ``create(ctx)``。
#. 全部工厂成功完成后，才向宿主交付可推进的模拟器。

器件 ``const`` 可保存 ``number``、``bool``、``string``、具名枚举、扁平记录、``bytes`` 及其可空值，不保存 ``sample``、``intent`` 或资源。创建期表达式使用字面量、``props``、器件常量、运算和受限纯函数调用。默认值与常量允许前向引用，其静态依赖图 MUST 无环；纯函数也可前向引用，但创建期调用不得读取运行时资源内容或调用 ``random``、``now``；初始意图中的 pin 引用与资源形参按创建期意图表达式规则使用。具体规则见 :doc:`/language/declarations` 和 :doc:`/language/functions`。

pin 初始意图使用创建期意图表达式，可引用本实例后声明的 pin；该引用不依赖目标 pin 的意图初值，也不形成意图求值依赖。初值中的 resistor 仍执行完整构造校验，非法值在工厂前失败。全板支路建立本身不求解、不发布采样，也不触发 process 或 reaction；首次求解仍由首次推进执行。

全板静态校验、创建期求值与断言 MUST 先于任何工厂调用。静态错误应携带可定位的实例 ID 和资源名；具体诊断 API 见 :doc:`/javascript/host`，故障行为见 :doc:`/errors`。

首次推进的初始电气求解完成后建立所有观察源的基线；同步响应不在基线建立时执行采集或响应体。启动过程产生的真实发布变化可先于其他实例的启动过程触发同步响应，器件初始化不得假定自身 start 总先于 reaction，见 :doc:`/execution/scheduling`。

工厂的同步返回、初始化期间的 JIT 注册及资源归属由 :doc:`/javascript/lifecycle` 定义。任何初始化失败均遵守 :doc:`/errors`：本次装配失败，释放失败实例所属的 context 资源与此前已创建的适配对象，不交付可运行的半成品。

初始化中的话题即时广播。工厂按上述顺序建立订阅，晚创建的订阅者只能接收建立订阅后的消息。全体实例就绪后需要发送的消息由宿主在装配成功后发布；话题行为与启动边界见 :doc:`/javascript/lifecycle`。

接口与核对点
------------------------------------------------

器件库、Board、生成类型及字节快照接口由 :doc:`/javascript/host` 统一维护。核心接收已解析属性值，配置保存格式与外部资源编码由宿主应用负责。运行中快照与 reset 不属于首版公开接口。

一致性测试见 :doc:`/conformance`；本章的关键核对点为：

* 静态错误、创建期求值失败或器件体断言失败使工厂调用次数为零；同类型的两个实例拥有独立资源。
* 默认值、枚举和 ``null`` 在 DDL 与 ``ctx.props`` 中一致；没有 ``default`` 的省略属性报告必填错误，数值属性拒绝 ``NaN`` 和正负无穷大。
* 默认值与器件常量的无环前向依赖可在创建期求值；循环依赖或运行时资源读取在任何工厂调用前拒绝。
* 修改装配输入字节不影响已捕获属性；属性在实例生命周期内固定。
* 工厂按 ``instances`` 顺序创建；初始化失败执行错误章规定的清理。
