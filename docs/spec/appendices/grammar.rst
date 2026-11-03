.. _spec-grammar:

================================================
DDL 文法
================================================

本附录给出首版 DDL 的完整表层 EBNF，供 Langium 文法与示例共同对照。解析结构不替代名称、类型、效果与值检查；例如可解析的触发路径仍需指向合法资源，创建期表达式仍需满足纯计算限制。

双引号表示终结符，逗号表示连接，``|`` 表示选择，方括号表示可选，花括号表示重复。``EOF`` 为文件结束；``identifier`` 表示标识符词形，声明名称还受关键字、内置名称和遮蔽检查约束。空白、注释、编码及字面量详见 :doc:`/language/lexical`。

文件、类型与声明
------------------------------------------------

.. code-block:: text

   document = device, EOF ;
   device = "device", identifier, [ "(", [ properties ], ")" ],
            "{", { member }, "}" ;
   properties = property, { ",", property }, [ "," ] ;
   property = identifier, ":", value-type, [ "default", expression ] ;

   member = enum-declaration | record-declaration | device-constant
          | state-declaration | derived-declaration
          | pin-declaration | memory-declaration | channel-declaration
          | notification-declaration | function-declaration
          | process-declaration | reaction-declaration | assert-statement ;

   value-type = value-base, [ "?" ] ;
   value-base = "number" | "bool" | "string" | "bytes"
              | "intent" | "sample" | identifier ;
   parameter-type = value-type | "pin" | "memory" ;

   enum-declaration = "enum", identifier, "{", enum-members, "}" ;
   enum-members = identifier, { ",", identifier }, [ "," ] ;
   record-declaration = "record", identifier,
                        "{", { record-field }, "}" ;
   record-field = identifier, ":", ( "number" | "bool" ), ";" ;

   device-constant = "const", identifier, [ ":", value-type ],
                     "=", expression, ";" ;
   state-declaration = "state", identifier, ":", value-type,
                       "=", expression, ";" ;
   derived-declaration = "derived", identifier, ":", value-type,
                         "=", expression, ";" ;

   pin-declaration = "pin", identifier,
                     [ "(", [ named-arguments ], ")" ],
                     [ "=", expression ], ";" ;
   memory-declaration = [ "public" ], "memory", identifier,
                        "[", expression, "]", ";" ;
   direction = "input" | "output" ;
   channel-declaration = direction, "channel", identifier,
                         ":", value-type, "(", named-arguments, ")", ";" ;
   notification-declaration = direction, "notification", identifier, ";" ;

identifier 类型位置必须解析到具名枚举或记录。各位置允许的值类型由 :doc:`/language/types` 的适用范围表约束，不能因文法包含 value-type 就把可空值或 string 加入通道。

pin 的可选初值须为非可空 intent，遵守创建期意图表达式限制；省略时为空意图。全部 pin 预绑定，初值可以前向引用本实例 pin。pin 参数只接受成对的 low、high，或同时省略；有限性、low < high 与无阈值时的 unknown 电平由 :doc:`/electrical` 定义。channel 必须有 capacity，bytes 通道另需 maxLength，可选 overflow；其他选项、重复选项或非 bytes 的 maxLength 均拒绝。参数值、长度、初值和 device-constant 采用创建期表达式检查。

函数与过程
------------------------------------------------

.. code-block:: text

   function-declaration = [ "pure" ], "fn", identifier,
                          "(", [ parameters ], ")",
                          [ "->", value-type ], block ;
   parameters = parameter, { ",", parameter }, [ "," ] ;
   parameter = identifier, ":", parameter-type ;

   process-declaration = "process", "start", block
                       | "process", identifier, "on", source-path, block ;
   source-path = identifier, { ".", identifier } ;
   reaction-declaration = "reaction", identifier, "on", source-path,
                          "as", "(", identifier, ",", identifier, ")",
                          [ "capture", captures ], block ;
   captures = capture-binding, { ",", capture-binding }, [ "," ] ;
   capture-binding = identifier, "=", expression ;

start 专用于可选且唯一的启动过程；反应过程的 identifier 不能是 start。source-path 必须指向本实例可观察的静态资源路径或 input notification。过程不能出现在普通调用目标中。

reaction 的 source-path 仅接受可比较的 state、derived 或 pin.sample 静态路径，不接受 notification。as 的两个名称及 capture 名称仅在响应体可见且不可重赋值；每项 capture 为独立纯表达式，不能引用这些绑定。纯性、可比较类型及响应体的同步效果由 :doc:`/language/functions` 校验。reaction、as、capture 为保留关键字。

函数参数无默认值，不支持同名重载、泛型或递归。pin / memory 形参只接受直接资源引用或资源形参；其他参数、结果与调用效果按 :doc:`/language/functions` 检查。

语句与等待
------------------------------------------------

.. code-block:: text

   block = "{", { statement }, "}" ;
   statement = local-declaration | assignment | intent-assignment
             | call-statement | if-statement | match-statement
             | while-statement | loop-statement | break-statement
             | continue-statement | return-statement | await-statement
             | assert-statement | redirect-statement ;
   local-declaration = ( "const" | "let" ), identifier,
                       [ ":", value-type ], "=", initializer, ";" ;
   initializer = expression | await-operation ;
   assignment = identifier, "=", initializer, ";" ;
   intent-assignment = identifier, ".", "intent", "<-", expression, ";" ;
   call-statement = postfix, ";" ;

   if-statement = "if", expression, block,
                  [ "else", ( block | if-statement ) ] ;
   match-statement = "match", expression, "{", match-arm,
                     { match-arm }, "}" ;
   match-arm = pattern, "=>", block ;
   pattern = [ "+" | "-" ], number-literal | string-literal
           | "true" | "false" | "none"
           | identifier, ".", identifier | "_" ;
   while-statement = "while", expression, block ;
   loop-statement = "loop", block ;
   break-statement = "break", ";" ;
   continue-statement = "continue", ";" ;
   return-statement = "return", [ expression ], ";" ;
   assert-statement = "assert", expression, [ ",", expression ], ";" ;
   redirect-statement = "redirect", "(", expression,
                        [ ",", "delay", ":", expression ], ")", ";" ;

   await-statement = await-operation, ";" ;
   await-operation = "await", "ticks", "(", tick-argument, [ "," ], ")"
                   | "await", identifier, ".", "receive", "(", ")" ;
   tick-argument = expression | "duration", ":", expression ;

call-statement 的 postfix 必须最终为合法同步调用，而非任意值表达式；有结果调用可以丢弃结果。赋值目标只接受可写 let 或 state；intent-assignment 的名称须为真实 pin 或 pin 形参。

await 不属于 expression，只能用于这里列出的完整右侧或独立语句。ticks 无值，不能初始化或赋值；receive 的结果类型由 input channel 决定。断言第一项须为 bool，消息须为 string，且消息只在失败时求值。

match 检查模式类型、重复与穷尽性；``_`` 只能位于最后。return、循环跳转、redirect、不可达语句及正常返回路径按 :doc:`/language/statements` 校验。

表达式
------------------------------------------------

.. code-block:: text

   expression = conditional ;
   conditional = logical-or, [ "?", expression, ":", conditional ] ;
   logical-or = logical-and, { "||", logical-and } ;
   logical-and = bit-or, { "&&", bit-or } ;
   bit-or = bit-xor, { "|", bit-xor } ;
   bit-xor = bit-and, { "^", bit-and } ;
   bit-and = equality, { "&", equality } ;
   equality = relational, { ( "==" | "!=" ), relational } ;
   relational = shift, { ( "<" | "<=" | ">" | ">=" ), shift } ;
   shift = additive, { ( "<<" | ">>" | ">>>" ), additive } ;
   additive = multiplicative, { ( "+" | "-" ), multiplicative } ;
   multiplicative = exponent, { ( "*" | "/" | "%" ), exponent } ;
   exponent = unary | postfix, "**", exponent ;
   unary = ( "+" | "-" | "!" | "~" ), unary | postfix ;
   postfix = primary, { ".", identifier
                      | "[", expression, "]"
                      | "(", [ arguments ], ")" } ;

   primary = number-literal | string-literal | "true" | "false"
           | "none" | "NaN" | "Infinity"
           | bytes-construction | intent-composition | record-literal
           | identifier | "(", expression, ")" ;
   bytes-construction = "bytes", "[", [ expression-list ], "]" ;
   intent-composition = "[", [ expression-list ], "]" ;
   record-literal = "{", [ field-initializers ], "}" ;
   field-initializers = field-initializer, { ",", field-initializer }, [ "," ] ;
   field-initializer = identifier, ":", expression ;
   expression-list = expression, { ",", expression }, [ "," ] ;
   arguments = expression-list | named-arguments ;
   named-arguments = named-argument, { ",", named-argument }, [ "," ] ;
   named-argument = identifier, ":", expression ;

exponent 的幂分支以 postfix 为左操作数，使 ``-2 ** 2`` 无法解析为合法表达式；括号允许 ``(-2) ** 2``，右侧可为一元 ``2 ** -2``。幂右结合，逻辑短路与三元惰性由 :doc:`/language/expressions` 定义。

bytes 为构造语法，不能作为普通值名称再解释为数组索引。``[ ... ]`` 只组合 intent，不是一般数组。record-literal 从期望类型获得具名记录身份。postfix 的形状不授予动态函数值、任意宿主成员或资源别名能力。

词法产生式
------------------------------------------------

以下字符集合使用单引号标出字符；``U+`` 范围指 Unicode 字符，转义检查另按 :doc:`/language/lexical` 执行。字面量内部不跳过空白或注释。

.. code-block:: text

   identifier = ( ascii-letter | '_' ),
                { ascii-letter | decimal-digit | '_' } ;
   ascii-letter = 'A'..'Z' | 'a'..'z' ;
   decimal-digit = '0'..'9' ;
   hex-digit = decimal-digit | 'A'..'F' | 'a'..'f' ;
   binary-digit = '0' | '1' ;
   octal-digit = '0'..'7' ;
   decimals = decimal-digit, { [ '_' ], decimal-digit } ;
   hexes = hex-digit, { [ '_' ], hex-digit } ;
   binaries = binary-digit, { [ '_' ], binary-digit } ;
   octals = octal-digit, { [ '_' ], octal-digit } ;
   number-literal = decimals, [ '.', decimals ],
                    [ ( 'e' | 'E' ), [ '+' | '-' ], decimals ]
                  | '0', ( 'x' | 'X' ), hexes
                  | '0', ( 'b' | 'B' ), binaries
                  | '0', ( 'o' | 'O' ), octals ;
   string-literal = '"', { string-character | escape }, '"' ;
   string-character = ? Unicode text except quote, backslash,
                        unescaped control characters and line breaks ? ;
   escape = '\\', ( '"' | '\\' | 'n' | 'r' | 't'
          | 'u', hex-digit, hex-digit, hex-digit, hex-digit
          | 'u', '{', hex-digit, { hex-digit }, '}' ) ;

词法单元采用最长匹配，多字符运算符优先于其前缀。标识符与数字连续拼接不能把非法字面量补成合法表达式；字符串内的注释记号是普通内容。空白为 ASCII 空格、制表符及换行；注释按词法章节跳过。

零时间让出使用 ``await ticks(0);``；跨边界不等于等待反馈网络全局稳定，见 :doc:`/execution/scheduling`。pin 数值合同见 :doc:`/electrical`，宿主装配与随机数配置见 :doc:`/javascript/host`。
