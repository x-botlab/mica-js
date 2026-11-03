.. _spec-builder-api-draft:
.. _spec-builder-api:

================================================
Builder 接口
================================================

本章定义首版 Builder 构造接口。精确字段与泛型签名由 :download:`builder.d.ts <../contracts/builder.d.ts>` 统一维护，配合 :doc:`builder`、:doc:`schema` 与 :doc:`validation` 使用。类型附件是规范合同，不表示 SDK 或运行时已经实现；包导出路径由 :doc:`/javascript/host` 确定。

类型描述与常量
------------------------------------------------

``types`` 提供 number、bool、string、bytes、intent、sample、单层 optional 及 pin / memory 形参描述。enum / record 声明返回可复用具名描述；前向引用通过 ``namedEnum(name, members)`` 与 ``namedRecord(name, fields)`` 携带预期结构，完成时核对实际声明。

具名描述和句柄保留定义归属，TypeScript 的结构类型通过不能扩大所属实例权限。内置枚举提供已确认成员；SampleStatus 的完整集合为 valid / floating，与 :doc:`/electrical` 一致。

.. list-table:: 常量输入
   :header-rows: 1
   :widths: 22 42 36

   * - 类型
     - 输入形式
     - 构造检查
   * - number、bool、string
     - 对应 JS 值。
     - 无隐式转换；普通 number 保留非有限值与负零。
   * - 可空值
     - 对应非空输入或 null；记录和 bytes 沿用下述常量输入形式。
     - null 必须有确定的目标可空类型；sample? 与 intent? 的宿主常量仅允许 null，其非空值通过 Value 提供。
   * - 枚举
     - 描述对象的 members 成员。
     - 核对类型名、成员名与归属，不接受裸字符串或公开数值编码。
   * - 记录
     - 目标记录描述及普通字段对象。
     - 严格检查全部声明字段，拒绝缺失、多余或错误字段并捕获快照。
   * - bytes
     - Uint8Array 或只读数字数组。
     - 捕获输入范围的副本，每项严格校验为字节。
   * - intent、sample
     - 通过电气构造或采样读取取得 Value。
     - 不允许手工伪造宿主常量。

``constant(type, value)`` 产生显式有类型常量。其他操作的 ``Operand<T>`` 接受匹配的常量简写或 Value；无法从裸 null、普通记录对象确定的具名目标，通过显式类型常量表达。动态记录用 record 构造，字段值可来自不同 Value，按对象字段插入顺序生成；字段读取用 field。

字节元素构造用 ``bytes(...elements)``，长度和索引用 length / index。sample 的 voltage、level、status 也通过 field 读取。optional 显式提升已生成的非空值；isNone 与 nonNull 表达经证明的收窄，具体证明规则见 :doc:`validation`。

同步计算与控制流
------------------------------------------------

具名方法覆盖 :doc:`/language/expressions` 的全部运算：positive / negate / not / bitNot，算术、比较、位运算、移位，以及 string 的 concat。equal / notEqual 显式接收目标类型，避免从不匹配的实参反向扩大类型。数值内置函数与 DDL 使用相同名称及结果。

local 必须有初值，getLocal / setLocal 显式读写。if / match / while / loop 使用结构化回调；match 接收按顺序排列的 pattern / emit 数组及可选兜底。break / continue 只作用于最近合法循环，不能越过计算子区域的边界。

while 使用唯一的方法，条件回调按所属上下文取得同步计算能力，运行时每轮重新执行。普通上下文可以在条件中同步写入或调用普通函数；pure 和创建期保持自身限制。条件不能等待。

and / or 的右侧及 select 的两分支使用显式惰性回调，while 条件与 assert 消息采用相同的计算回调返回合同。普通同步计算视图（SyncCompute、ProcessCompute、ReactionCompute）的回调接受 ``Operand<T> | void``；纯与创建期计算视图的回调仍须返回 ``Operand<T>``。返回 Operand 时，Builder 为仍可正常结束的生成路径追加 yield；返回 void 仅在生成控制流的全部路径已经终结时合法，例如 SyncCompute 中直接 redirect 或各分支均 redirect。若仅部分路径 redirect，其余正常路径仍须通过回调返回 Operand。仍有正常路径却返回 void 时，Builder / IR 校验报告缺失 yield / 产值；MUST NOT 把 undefined 当成模型值。TypeScript 不验证生成控制流是否全部终结，普通回调忘记 return 属于构造验收，而非预期类型错误。

已经提前生成的 Value 仍是提前求得的结果，不会因传入回调而自动变成延迟表达式。

assert 的消息也通过同步计算回调生成，只有条件失败才求值。计算子区域可以使用自己的局部和内部循环，但不能 return 外层函数或跳转外层循环。

调用与返回方法
------------------------------------------------

call / callValue 分别生成无返回和单结果同步调用；callPure / callPureValue 额外要求目标显式为 pure fn。动态结果无法从字符串名推导时显式提供期望类型，绑定时核对真实签名。调用实参按函数参数顺序给出；其 Value 的生成顺序决定实际求值顺序。

按上下文提供返回方法：无返回函数与过程使用 ``return()``，有返回函数、derived 和创建期产值体使用 ``returnValue(value)``。JIT 指令没有函数返回方法。构造回调中的 JS return 只结束宿主构造回调；只有约定产值的计算回调才把返回的 Operand 转为 yield。

函数、过程及条件计算的具体能力由 :doc:`validation` 的效果表规定。运行期普通计算可以使用 now / random；纯与创建期构造体不提供这些方法。捕获外层 Builder 不能绕过上下文检查。

定义构造
------------------------------------------------

``createDeviceBuilder`` 创建定义构造器。property、constant、state、derived、pin、memory、channel、notification 接收描述对象。fn / pureFn 接收名称、有序参数数组、可选返回类型及构造回调；回调按参数名取得对应 Value 或资源形参句柄。

start 声明可选且唯一的启动过程；on 使用名称与非空静态 sourcePath 数组，例如 ``['probe', 'sample', 'level']``，最终源须为可观察且可比较的值或 input notification，intent 与 intent? 拒绝。这些方法生成静态声明，不在运行期新增资源。

除 pin.initial 外，创建期 default / value / initial / length / capacity 等字段接受常量，或返回指定类型的 CreationBody 构造回调。回调在构造期执行一次，生成的计算在每次实例创建时执行。纯运行期 derived 使用 pure 构造体。device 级 assert 接收创建期无返回构造回调，消息仍为惰性计算。

.. code-block:: typescript

   const device = createDeviceBuilder({ name: 'Example' });
   device.property({ name: 'capacity', type: types.number, default: 16 });
   device.memory({ name: 'data', length: body => {
     body.returnValue(body.multiply(body.readProperty('capacity', types.number), 2));
   } });
   device.state({ name: 'count', type: types.number, initial: 0 });
   device.fn({
     name: 'increment',
     params: [{ name: 'amount', type: types.number }],
     returns: types.number,
   }, (body, args) => {
     const previous = body.readState('count', types.number);
     const next = body.add(previous, args.amount);
     body.writeState('count', next);
     body.returnValue(next);
   });
   const definition = device.finish();

定义内前向引用在 finish 统一解析。每个声明位置的允许类型、创建期依赖和执行效果以语言规范为准；泛型接受某个 Type 不替代这些校验。

初始 pin 意图构造
------------------------------------------------

``pin({ name, low?, high?, initial? })`` 的 initial 仅接受 ``(body: InitialIntentBody) => void``，正常路径调用 ``returnValue`` 返回非可空 intent。阈值仍成对给出；省略 initial 为空意图，显式空意图用 ``combineIntents()``。该回调在定义构造时生成 IR，每次实例创建时求值，不接受宿主 intent 常量。

InitialIntentBody 在创建期值计算基础上增加 ``pin(name)``、``resistor(to, resistance)`` 与 ``combineIntents(...values)``。pin 返回符号 PinRef；to 接受本实例 pin 名称或 PinRef，允许前向引用，finish 统一解析，因此无需额外的声明 / 设置两阶段 API。分支继续使用 InitialIntentBody；select、while 条件、短路和断言消息使用 InitialIntentCompute，保持相同能力。pure 调用使用现有 callPure / callPureValue，并在完成时递归检查创建期读取限制及资源实参。

该专用视图不提供 state、derived、sample、memory 读取或运行效果；普通 CreationBody 不因该字段获得 pin 与 resistor 方法。property、const、state 的类型适用范围保持原合同，字符串名称与调用结果描述仍须通过 IR 校验。

.. code-block:: typescript

   device.property({ name: 'resistance', type: types.number, default: 1000 });
   device.pin({ name: 'a', low: 0.8, high: 2, initial: body => {
     body.returnValue(body.resistor(body.pin('b'),
       body.readProperty('resistance', types.number)));
   } });
   device.pin({ name: 'b' });

此例与 ``pin a(low: 0.8, high: 2) = [resistor(to: b, resistance: resistance)];`` 的初始意图一致。全部资源预绑定、工厂前全板支路建立及首次 runUntil 的行为见 :doc:`resources`；后续 writeIntent 完整替换初值。

同步 reaction 构造
------------------------------------------------

``reaction(options, capture, emit)`` 生成独立 reaction 声明。options 包含 name、非空 sourcePath、sourceType、previous / current 源码名称、有序 captures 描述及可选 source。sourceType 与各描述的 type 限于 ``ComparableValue``；字符串路径的实际资源类别和最终类型在 finish 核对。captures 描述按声明顺序给出 name、type 与可选 source；名称唯一且不遮蔽已有器件成员及两个源绑定。

第二参数是按 capture 名称索引的构造回调对象，每个回调获得独立的 ``ReactionCaptureBody<T>``，用 returnValue 交付声明类型的纯计算结果；键集合须与描述完全一致。Builder 按 captures 数组而非对象属性顺序调用这些回调，各自关闭并隔离句柄。构造期宿主 JavaScript 回调执行一次，运行期计算仅在首次基线之后的已发布源变化时执行。空 captures 使用 [] 和 {}。

emit 获得专用 ``ReactionBody`` 与只读 ``ReactionBindings<T, C>``。bindings.previous / current 为 ``Value<T>``，bindings.captures 按描述名称映射为各自类型的 Value。Builder 在响应体首部按 previous、current、captures 顺序生成 reactionValue / reactionCapture 产值操作，这些句柄是生成的 IR 操作数，不是构造期 JS 值或隐式资源读取。previous / current 的 API 属性名固定；options 中的名称保留 DDL 绑定及诊断名称。它们与其他 Value 一样仅在所属响应体和可见子区域可用。

ReactionBody 提供普通同步效果及 return，不提供 wait、receive、redirect、elapse、waitUntil、stop 或 returnValue；条件、惰性计算与断言消息的计算回调使用独立 ``ReactionCompute`` 能力视图，分支和循环体继续使用 ReactionBody，保持相同同步效果限制。调用字符串指向的辅助函数仍接受传递效果校验。ReactionCaptureBody 不获得任何 reaction 绑定；捕获外层 JS 变量中的 Value 也不能绕过独立执行体检查。

.. code-block:: typescript

   device.reaction({
     name: 'remember',
     sourcePath: ['count'],
     sourceType: types.number,
     previous: 'before',
     current: 'after',
     captures: [{ name: 'saved', type: types.bytes }],
   }, {
     saved: capture => capture.returnValue(capture.copyBytes('data', 0, 2)),
   }, (body, values) => {
     body.assert(body.notEqual(types.number, values.previous, values.current));
     body.send('outgoing', values.captures.saved);
   });

每轮全部捕获完成后才运行全部同步响应；稳定排序、基线和下一发布边界见 :doc:`/language/functions`。这些规则不改变普通 on 过程的非重入与挂起语义，仅确定其后的阶段优先级。

资源操作
------------------------------------------------

.. list-table:: 完整资源方法分组
   :header-rows: 1
   :widths: 22 48 30

   * - 对象
     - 方法
     - 行为来源
   * - 静态与共享值
     - readProperty、readConst、readState、readDerived；writeState。
     - :doc:`resources`。
   * - memory
     - memory、memoryLength、load8 / 16le / 16be / 32le / 32be、对应 store、copyBytes。
     - :doc:`/memory`。
   * - pin
     - pin、readSample、resistor、combineIntents、writeIntent、refEqual。
     - :doc:`/electrical`。
   * - 端点
     - receive、send、notify。
     - :doc:`/channels`。
   * - 时间与随机
     - wait、now、random。
     - :doc:`/language/builtins`、:doc:`/execution/index`。
   * - JIT
     - instruction、elapse、waitUntil、redirect、stop、finish。
     - :doc:`/jit/index` 及其执行章节。

pin / memory 操作直接接受资源名或对应形参句柄。向函数传入直接资源时，使用 pin(name) / memory(name) 生成引用；普通字符串实参始终是 string 值，不暗中当作资源名。resistor 只接受本实例 pin 目标；板级电源与地不进入此接口。combineIntents 无参数时生成空意图。pin 声明的 low / high 必须同时省略或同时提供，创建期执行时检查有限且 low < high；resistor 在运行期构造时检查 1 mΩ 至 1 GΩ 的闭区间，不在 JS 生成 IR 时提前执行动态数值。

send / notify 无返回、不等待；receive 只在 ProcessBody 提供。wait / elapse / redirect 的时长输入接受常量或动态 Value，在实际执行位置捕获并校验。JIT 的 waitUntil 保持指令和块尾位置限制，详见 :doc:`schema`。

值与循环示例
------------------------------------------------

以下片段假设 ``body`` 是所属函数体 Builder：

.. code-block:: typescript

   const saved = body.readState('x', types.number);
   body.writeState('x', 10);
   body.writeState('y', saved);

   const result = body.local(types.number, 0);
   body.if(body.lessThan(saved, 10), yes => {
     yes.setLocal(result, 1);
   }, no => {
     no.setLocal(result, 2);
   });

   body.while(test => test.lessThan(test.getLocal(result), 4), loop => {
     loop.setLocal(result, loop.add(loop.getLocal(result), 1));
   });
   body.writeState('output', body.getLocal(result));

``saved`` 捕获写入 x 之前取得的值；循环每轮重算局部槽的条件。分支结果通过外层槽传出，而非把某分支专属的临时句柄用于外层。

来源与完成
------------------------------------------------

withSource 设置生成节点默认来源，不生成仿真操作。回调体的临时构造视图在返回后关闭，外层合法构造器仍可继续；关闭不创建新局部作用域或延长句柄寿命。

DeviceBuilder.finish 返回不可变 DeviceIR，JitBlockBuilder.finish 返回不可变 BlockIR。重复完成、失败后继续、非法句柄或终结后追加均按 :doc:`validation` 报告英文诊断。

精确声明附件
------------------------------------------------

附件中的 JSDoc 解释值快照、引用归属、时间单位、尾位置和错误边界。辅助接口组合上下文能力，不代表额外运行时对象。此处不重复规定宿主接口规范的宿主 SDK 导出布局。

.. literalinclude:: ../contracts/builder.d.ts
   :language: typescript
   :linenos:

类型检查
------------------------------------------------

:download:`type-tests.ts <../contracts/type-tests.ts>` 包含正向构造样例和预期类型错误，仅用于 tsc，不执行。它验证参数推导、具名类型、资源引用及上下文方法限制；作用域、非空证明、完整路径、真实名称与仿真效果仍需后续实现验证。

在仓库根目录执行：

.. code-block:: powershell

   pnpm exec tsc -p docs\spec\contracts\tsconfig.json

该配置同时检查宿主 :doc:`/javascript/host` 的类型用例，启用 exactOptionalPropertyTypes 与索引越界提示，并将现有 lifecycle 类型映射到仓库源码，不需要安装新的 SDK 包。
