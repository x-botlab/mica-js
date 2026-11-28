---
'@mica-js/simulator': minor
'@mica-js/sdk': minor
---

新增可选的 Direct JIT 启动预编译入口。器件在加载固件后可提供启动 PC，宿主在仿真推进前校验并编译符合条件的入口。编译工件可在同一宿主的会话间复用，Flash 写入继续使当前会话的代码缓存失效。
