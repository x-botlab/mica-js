.. _spec-ir-schema:

================================================
IR 数据结构
================================================

共享 IR 使用有序操作、显式结果编号和嵌套结构化区域。DDL 编译器、Builder 和按 schema 构造的输入对象均接受 :doc:`validation` 的同一套检查。执行后端可以降低为内部基本块，但保留本章定义的类型、执行位置与效果。

精确字段由 :download:`ir.d.ts <../contracts/ir.d.ts>` 定义。本章解释字段的语义和静态类型不能单独保证的条件。首版冻结内存中的 TypeScript 数据合同；文件编码、传输协议与跨版本兼容按后续实际需求另行规定。

根结构与声明
------------------------------------------------

``DeviceIR`` 描述一个自包含 device，``declarations`` 按声明顺序保存类型、属性、常量、资源、函数、过程与创建期断言。名称、关键字、遮蔽及前向引用规则沿用 :doc:`/language/lexical`；一个定义可以由装配复用于多个实例。

``DeclarationIR`` 中的枚举与记录声明建立具名类型；普通声明的 ``type`` 只引用这些类型名称。内置枚举由语言环境提供。所有类型使用位置仍接受 :doc:`/language/types` 的适用范围检查；schema 能表示某个类型，不等于该类型可用于所有声明。

.. list-table:: 声明中的可执行体
   :header-rows: 1
   :widths: 30 35 35

   * - 声明
     - 计算内容
     - 限制及结果
   * - property、const
     - 可选 default、必需 value。
     - 创建期读取；返回声明类型。省略 default 与显式 none 不同。
   * - state
     - 必需 initial。
     - 创建期读取；返回声明类型。
   * - pin
     - low / high 同时省略或同时给出；可选 initial。
     - 阈值为创建期 number 计算；initial 为返回非可空 intent 的独立 ComputationIR，省略为空意图。
   * - memory
     - length 必需。
     - 创建期计算，结果为 number；数值合法性按资源合同检查。
   * - channel
     - capacity、可选 maxLength / overflow。
     - 创建期计算；前两者为 number，overflow 为内置 Overflow。bytes 必需 maxLength，其他负载拒绝该字段。
   * - derived
     - value。
     - 纯运行期计算，返回声明类型。
   * - function
     - params、可选 returns、body。
     - 无环同步调用；pure 声明施加纯效果限制。
   * - start、on
     - body；on 另有 sourcePath。
     - 可恢复过程；on 的路径指向合法静态触发源。
   * - reaction
     - sourcePath、sourceType、previous / current 名称、有序 captures、body。
     - 独立同步响应；capture 为独立纯计算，body 允许普通同步效果并拒绝挂起及 redirect。
   * - assert
     - body。
     - 无返回值的创建期语句体，只允许创建期计算及断言。

``ComputationIR`` 为独立产值计算体，正常结束路径使用 ``returnValue``。它从引用位置取得创建期、derived 或 reaction capture 用途，结果类型与声明要求一致。资源配置使用共享操作语言，而非另一个宿主表达式格式。

pin 的成对阈值在创建期检查有限且 low < high，省略时 level 恒为 unknown；完整电气合同见 :doc:`/electrical`。

pin.initial 的 type 固定为 ``{ kind: 'intent' }``，正常结束路径必须 returnValue。空意图由空组合构造产生，不能用 none 或宿主数组常量代替。它可引用后声明的本实例 pin；全部 pin 先预绑定，再求值 initial。资源引用身份不依赖目标 pin 的 initial，因此相互引用不构成初始化值依赖环。创建期效果、全板支路建立及首次求解顺序分别见 :doc:`validation` 与 :doc:`resources`。此字段不扩大 property、const 或 state 的合法类型位置。

memory 的 ``public``、函数的 ``pure``、端点的 ``direction`` 在 IR 中显式存在；Builder 将省略的 public 规范化为 false。overflow 省略时仍按 :doc:`/channels` 的默认策略处理。

创建期依赖顺序与断言时机以 :doc:`/language/declarations` 为准；不能直接把 declarations 数组当成不检查依赖的初始化脚本。

reaction 声明与快照引用
------------------------------------------------

``kind: 'reaction'`` 是独立声明，不编码为 on 过程。sourcePath 是非空静态路径数组，根须为 state、derived 或 pin.sample；路径最终类型必须与 sourceType 严格匹配。``ComparableTypeIR`` 表示 number、bool、string、bytes、sample、具名 enum / record 及其单层 optional，排除 intent 与资源。

previous 和 current 是响应体绑定的源码名称；二者及 captures 的名称遵守普通局部名称规则，彼此唯一且不遮蔽器件成员。captures 为有序 ``ReactionCaptureIR`` 数组，各项含 name、value 和可选 source；value 是返回可比较类型的独立纯 ComputationIR。空数组表示没有 capture。每个计算独立拥有结果与局部编号空间，不能访问旧值、新值或任何 capture 绑定，也不能引用其他计算体的结果。

响应体通过两种产值操作显式取得运行期快照：``reactionValue { binding: 'previous' | 'current', result, type }`` 与 ``reactionCapture { index, result, type }``。index 是 captures 数组中从零开始的非负安全整数；前者 type 必须等于 sourceType，后者必须等于目标 value.type。读取不重新求值源或捕获表达式。它们只在本 reaction 的 body 及其词法嵌套区域合法，不能进入 capture、其他入口、辅助函数或 JIT 指令；函数 parameter 不能替代这些操作。每个读取结果仍接受通常的唯一编号与支配关系检查。

第一次观察只建立基线；之后每次已发布变化都保存一组旧值 / 新值。稳定实例及声明顺序确定本轮捕获和响应顺序，单个 captures 按数组顺序求值。本轮全部 capture 完成后，才同步执行全部 body；body 产生的更新在下一发布边界形成新一轮，不插入当前轮，也不采用过程 busy / pending 合并。完整行为见 :doc:`/language/functions`。

类型、常量与引用
------------------------------------------------

``ValueTypeIR`` 表示基础值、具名枚举 / 记录，或包裹一个非空类型的单层 optional。资源形参使用独立的 pin / memory 类型，不进入普通值系统。

常量操作通过 ``ConstantIR`` 捕获值，再产生一个有类型的结果编号。number 直接保留 binary64 的 NaN、无穷大与负零，不经过 JSON 数值转换。记录常量携带类型名及有序字段数组；字段唯一、齐全且类型匹配。枚举常量携带类型名和成员名，不暴露数值编码。bytes 常量为不可变字节序列，每项严格校验为 0 至 255 的整数。

none 常量的结果类型必须为一个确定的 optional 类型。``optional`` 操作把非空 T 的结果提升为 T?；普通 T? 输入必须使用匹配的结果类型，不能把裸编号当成隐式类型转换。sample 从 pin 读取，intent 通过电气构造操作产生。

``read`` 操作以 resource 类别和 name 区分 property、const、state、derived。pin / memory 引用使用类别加名称，或当前函数参数的位置。板级固定电位不构成器件引用；resistor 的目标只接受 pin 引用。函数与端点由相应操作中的名称引用。名称在绑定后转换为执行端内部引用，执行期间不重复字符串查找。

函数资源参数只能是 pin / memory 引用。它们保持所属实例身份，不经参数读取操作变成普通值；``parameter`` 产值操作仅用于值形参，index 按参数声明表从零计数。资源形参的引用可以继续传入同步函数，不能存入 Local、返回值或记录。pin.initial 调用链内可将本实例直接 pin 引用传入 pure fn 的 pin 形参，并继续传给 resistor 或下一层 pure 调用；这一引用传递不属于运行资源读取。其他创建期计算仍保持其原有资源引用限制。

结果编号与局部槽
------------------------------------------------

``ResultId`` 与 ``LocalId`` 均为非负安全整数，但拥有独立编号空间。一个结果编号在同一独立执行体内只定义一次，局部槽编号也只声明一次。创建期独立计算、derived、函数、过程、每项 reaction capture、reaction 响应体以及每条 JIT 指令各有自己的编号空间；嵌套区域共享所属执行体的分配空间。

编号必须在可见位置定义并支配其使用。外层值和槽可以进入子区域；分支、循环体与计算子区域的临时结果不能泄露到外层。分支汇合通过外层 Local，或显式产值的 select 等操作完成。编号的偶然相同不构成跨体引用许可。

结果编号保存该次动态执行的值。循环每轮执行到同一产值节点时形成本轮结果；跨实际挂起恢复时保留当前帧中的值，不重放已完成前缀。局部槽在执行到声明时初始化，循环体内每轮重新初始化。

区域与控制流
------------------------------------------------

``RegionIR.operations`` 是执行顺序。if 只执行选中子区域；match 将被匹配值求值一次，按模式顺序选择且不贯穿。模式、重复、穷尽性和正常结束路径沿用 :doc:`/language/statements`。number 模式须为有限值，正负零视为重复；NaN 与 Infinity 可为普通常量，但不作为 match 数值模式。

while 的 test 是结果为 bool 的 ``ValueRegionIR``，每轮重新执行；body 为语句区域。条件允许所在上下文合法的同步计算，包括普通路径的同步副作用；条件计算自身不能挂起。continue 回到条件区域，break 离开最近一层循环。loop 没有条件区域。

and / or 的右侧、select 的两分支、while 条件和 assert 消息均为计算子区域。每条正常结束路径使用 ``yield`` 交付声明类型的值；yield 只结束当前计算区域，与调度意义的让出执行无关。它不返回外层函数，不跳转外层循环。区域内部新建的循环仍可使用自己的 break / continue。

在允许控制转向的普通上下文计算区域内，可以直接 redirect 或通过已绑定辅助调用 redirect；转向路径没有正常产值，不要求在其后追加 yield。Builder 普通同步计算回调返回 Operand 时，为仍可正常结束的生成路径追加 yield；返回 void 时，生成控制流的全部路径必须已经终结。只有部分路径转向时，其余正常路径仍须产值。仍有正常路径却返回 void 属于缺失 yield / 产值，不能把 undefined 编码为模型值。纯与创建期计算回调仍须返回 Operand；其视图不获得 redirect 能力。计算区域的可挂起操作始终拒绝；只在允许的过程体和 JIT 阶段生成等待。

return / returnValue 结束所属函数或独立计算体；过程和 reaction 响应体的 return 结束本次运行。所有必然终结节点之后继续追加同路径操作均拒绝。可能 redirect 的普通调用保留正常返回路径，不能据此推定后缀不可达。

操作的类型与效果
------------------------------------------------

每个产值操作都含 result 与 type；该 type 是待核对信息，而不是允许调用方自由指定的类型断言。

.. list-table:: 产值操作约束
   :header-rows: 1
   :widths: 28 72

   * - 操作
     - 输入与结果检查
   * - constant、read、parameter、localRead
     - 与常量、实际声明、参数或局部槽类型严格核对。
   * - reactionValue、reactionCapture
     - 仅限所属 reaction 响应体；按 sourceType 或 captures[index].value.type 核对结果类型和索引范围。
   * - unary、binary、numeric
     - 按 :doc:`/language/expressions` 和 :doc:`/language/builtins` 的输入、参数数量和结果类型检查。concat 只接受 string。
   * - record、field
     - record 结果为具名记录，字段数组按生成顺序求值；field 只读取实际记录字段或已定义的 sample 字段。
   * - bytes、length、index
     - bytes 元素为 number，执行时检查字节值；length 接受非空 string / bytes；index 结果分别为 string / number，执行时严格检查索引。
   * - optional、isNone、nonNull
     - optional 保持内层类型；isNone 返回 bool；nonNull 要求当前路径的非空证明，返回内层类型。
   * - memoryLength、load、copyBytes
     - 长度和 load 返回 number；copyBytes 返回 bytes。偏移、长度和写值按存储合同在执行时校验。
   * - readSample、电气构造、refEqual
     - 分别返回 sample、intent、bool；电气构造为 resistor / combineIntents，目标仅 pin；引用身份比较只接受同类 pin 或 memory。电阻构造在执行处校验 :doc:`/electrical` 的数值范围。
   * - callValue、receive
     - 与实际目标签名或 input channel 负载匹配；receive 仅用于过程体。
   * - now、random
     - 返回 number，但分别具有时间依赖与随机序列效果，不属于纯计算。
   * - and / or、select
     - 前者条件及区域结果为 bool；select 条件为 bool，两分支结果与声明类型一致。

call / callValue 的 args 按形参顺序保存已经求得的结果编号或资源引用。DDL 命名实参按源码顺序生成计算操作，再将结果引用放到对应形参位置；重排引用不允许重排实际计算。无返回 call 只绑定无返回值函数；丢弃有值调用结果时仍生成 callValue。

所有效果都从实际节点和静态调用图推导。call 的 pure 字段表示此调用要求显式 pure fn，不能作为目标纯性的证明。pure fn 的局部更新仍合法；资源写入、消息、挂起、redirect、now 和 random 按 :doc:`/language/functions` 拒绝。创建期对读取集合再收窄。

JIT 块
------------------------------------------------

``BlockIR.instructions`` 至少包含一条指令。pc 和 nextPc 为有限 number，不额外要求整数、单调或唯一。相邻指令的前一 nextPc 必须等于后一 pc；接纳时第一条 pc 必须匹配本次 translate 输入。末条 nextPc 可以指向块外。

每条指令的 body 共用普通操作模型，但不含过程 receive、wait 或函数 return。允许 elapse、stop、redirect 和满足尾位置要求的 waitUntil。elapse 与 redirect 在执行处捕获动态时长，后续资源变化不修改已经开始的耗时阶段。

waitUntil 可以处于 if / match 的尾分支；从该位置返回各外层区域到指令末尾的路径不能再有可执行后缀，所在指令必须为块末条。循环及计算子区域内拒绝 waitUntil。立即满足也只结束该指令路径，不执行额外后缀。详细恢复和代码失效合同见 :doc:`/jit/execution`、:doc:`/jit/code-memory`。

本次 schema 校验得到的是未绑定的描述，不是可执行代码，也不是持久化的恢复帧。实例、入口、代码版本与代次检查仍由运行时接纳阶段完成。

精确声明附件
------------------------------------------------

以下声明只定义合同；检查函数与错误类尚未实现。注释解释单位、作用域及校验边界，字段和语义约束共同构成首版 IR。

.. literalinclude:: ../contracts/ir.d.ts
   :language: typescript
   :linenos:
