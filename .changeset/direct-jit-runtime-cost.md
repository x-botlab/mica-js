---
'@mica-js/compiler': minor
'@mica-js/simulator': minor
---

降低 direct JIT 的执行与代码规模开销，并把忙等环交给运行时折叠。

- 直编发射器按活跃区间复用局部槽：一条指令体的上千个临时值现在共享十几个槽。外设写块的生成源码从 93 KB 降到 35 KB、声明寄存器从 1441 降到 15，单次执行 1.1 μs → 0.1 μs；带 16 脚 intent 树的服务块 1.9 μs → 0.6 μs。
- 分片预算改用生成的源码字符数（单片 36 KB、单体上限 48 KB）。V8 的可优化规模取决于函数体积而不是槽数，槽数压缩后按旧阈值会把整份程序退化成单体大函数。
- 条件检查（`if`/`select`/`and`/`or`/`assert`）内联 `typeof` 判断，非布尔值才调用 `H.checkBoolean`。
- `elapse` 接受运算得到的时长：动态时长保留槽位，在操作所在位置经 `H.checkDuration` 校验后使用，与 generator 后端一致。
- `JitOptions.delays` 声明寄存器递减型忙等环（`subs`/`bne`）。运行时在环头按剩余推进窗口取整折叠轮次，越过窗口时仍逐轮执行，不越过推进目标与下一事件。
- 器件侧：32/16 位访存改用 `load32le`/`store32le` 一类的宽操作（一次按宽度校验，而不是每字节一次）；GPIO 配置寄存器（MODER/OTYPER/PUPDR/AFR）在 state 里维护影子，引脚意图只读 state，写寄存器时写穿到寄存器映像。
