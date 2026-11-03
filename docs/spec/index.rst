.. _spec-index:

================================================
Mica 器件仿真规范
================================================

本规范定义 Mica 中器件的描述、装配与执行方式，规定 DDL、器件 JavaScript 和共享 IR 共同遵守的行为。

:doc:`introduction` 说明规范的适用范围、约束用语和规范状态；:doc:`model` 定义贯穿后续章节的对象、边界与交互关系。

正文按依赖关系组织：先阅读 DDL 与电气、存储、通道的资源语义，再阅读时间与调度；在此基础上理解共享 IR、Builder 与 JIT，最后进入板级装配、JavaScript 和宿主接口。组合示例之后给出一致性要求，术语与完整文法集中放在附录。

.. toctree::
   :maxdepth: 2
   :numbered:
   :caption: 规范正文

   introduction
   model
   language/index
   electrical
   memory
   channels
   execution/index
   ir/index
   jit/index
   assembly
   javascript/index
   errors
   examples/index
   conformance
   appendices/glossary
   appendices/grammar
