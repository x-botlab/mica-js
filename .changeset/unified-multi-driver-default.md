---
'@mica-js/simulator': minor
---

多驱动网（一个网络上接多个驱动引脚）默认按线或求解，不再需要开关：移除 `CircuitCompilationOptions.allowMultiDriver`、`CircuitElectricalOptions.allowMultiDriver` 与 `TopologyOptions.allowMultiDriver`，并移除 `driver-conflict` 诊断与错误码。双向 GPIO 与按钮接在同一个网这类必须的行为仿真因此可以直接编译，也不会再产生警告；单驱动网的求解路径与结果不变。
