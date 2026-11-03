.. _spec-language:

================================================
DDL 语言
================================================

DDL 通过声明建立器件资源，通过表达式、函数和过程描述资源如何变化。属性在实例创建时确定；运行中的行为使用同一实例的资源，按仿真调度规则执行。

:doc:`lexical` 定义文件与名称，:doc:`types` 定义可以计算和传递的值，:doc:`declarations` 定义值与资源的绑定方式。:doc:`expressions`、:doc:`statements`、:doc:`functions` 和 :doc:`builtins` 共同定义行为。

.. toctree::
   :maxdepth: 2

   lexical
   types
   declarations
   expressions
   statements
   functions
   builtins

描述与执行
------------------------------------------------

DDL 源文件使用 ``.ddl`` 扩展名。声明经名称解析、类型检查和资源绑定后形成 :doc:`/ir/index`；执行时使用 :doc:`/execution/index` 定义的时间与入口模型。

静态检查可以确定的错误在执行前报告，例如名称无法解析、函数参数不匹配、可空值尚未检查便参与算术、派生依赖成环。依赖运行时数值的范围检查在对应操作发生时执行。错误分类及故障后的状态由 :doc:`/errors` 规定。

普通函数同步完成。过程可以在等待条件未满足时挂起，稍后从原位置继续。一次语法上的等待是否结束同步片段，取决于该操作是否实际挂起；具体规则见 :doc:`/execution/scheduling`。

示例与文法
------------------------------------------------

以下示例声明一个计数状态，并在两个更新之间推进仿真时间。``period`` 是示例属性，``ticks`` 的时间含义见 :doc:`/execution/index`。

.. code-block:: text

   device Counter(period: number default 3) {
     state count: number = 0;

     fn advance(amount: number) {
       count = count + amount;
     }

     process start {
       loop {
         advance(1);
         await ticks(period);
       }
     }
   }

首版语言的文件结构、类型、运算和控制语法在本章冻结，完整 EBNF 见 :doc:`/appendices/grammar`。文法决定可解析的结构；名称、类型、效果与操作合法性由对应合同进一步检查。调度、电气数值与宿主接口分别由 :doc:`/execution/scheduling`、:doc:`/electrical` 和 :doc:`/javascript/host` 定义。

一致性检查
------------------------------------------------

相同实例、初始资源和输入条件下，DDL 与 Builder 生成的等价行为应产生相同的资源变化、时间、输出与故障结果。跨入口共享、外部消息与动态执行分别遵守 :doc:`/execution/sharing`、:doc:`/channels` 和 :doc:`/jit/index`，检查范围见 :doc:`/conformance`。
