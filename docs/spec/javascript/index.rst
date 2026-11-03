================================================
JavaScript 与宿主
================================================

每个器件定义都配对一个 JavaScript 工厂。工厂按实例创建适配对象，通过 context 初始化资源、暂存输入、订阅话题与注册 JIT 入口；运行时通过同步钩子 ``sync`` 交付输出批次。

JavaScript 与 DDL 在同一仿真 Worker 内协作。器件定义与实例的边界见 :doc:`/model`，平坦板级结构、显式工厂配对与属性见 :doc:`/assembly`。

.. toctree::
   :maxdepth: 2

   interfaces
   lifecycle
   host

阅读关系
------------------------------------------------

先由 :doc:`interfaces` 了解端点投影与数据所有权，再由 :doc:`lifecycle` 理解创建、同步、话题和释放顺序；最后阅读 :doc:`host` 的 Board、library、SDK 与宿主合同，精确签名见 :download:`host.d.ts <../contracts/host.d.ts>`。重新初始化通过销毁旧板后创建独立新板完成。

以下行为由对应章节统一规定，本章组通过引用使用：

* :doc:`/language/types`：消息与属性涉及的值类型。
* :doc:`/memory`：存储访问与借用。
* :doc:`/channels`：输入暂存、FIFO、通知、溢出和批次交换。
* :doc:`/electrical`：引脚连接的求解与采样。
* :doc:`/execution/index`：仿真时间与推进终点。
* :doc:`/execution/scheduling`：同刻阶段及入口调度。
* :doc:`/execution/sharing`：同步片段与实例内共享。
* :doc:`/jit/index` 与 :doc:`/jit/code-memory`：动态执行与受控代码写入。
* :doc:`/errors`：整板故障、部分交付与恢复。
* :doc:`/conformance`：一致性验证。

接口状态
------------------------------------------------

接口及生命周期、批次和故障行为均已确认，但当前运行时与已发布包尚未实现这些合同。字节属性和字节消息统一为可留存 ``ReadonlyBytes``；公开存储使用本板可复用、销毁失效的 ``BorrowedBytes``。

类型由 DDL 端点和属性投影，器件生成类型由器件模块导出。通用器件 SDK 位于 ``/device``，IR 与 Builder 位于 ``/model``，Board/library 位于根入口，DDL 编译隔离于 ``/ddl``。完整导出布局与可选字段校验以 :doc:`host` 及类型附件为准；事件和释放复用 ``@mica-js/core/lifecycle``。
