; 频率门控最小固件：T1 每 100 µs 中断一次，累计 10000 次后用 T0 的下降沿计数。
;
; - 12 MHz、T1 1T、模式 0，重装 0xFB50 -> (0x10000 - 0xFB50) = 1200 个周期 = 100 µs。
; - T0 计数器模式，对 P3.4 的 NE555 输出下降沿计数。
; - 第 0x2710 = 10000 次 T1 中断时停 T0，把 TL0/TH0 写入 IRAM 0x33/0x34，
;   并在 0x32 置 done 标志。
; - 0x30/0x31 是中断计数（低字节在前），只用于比较；0x40 只用于保持主循环执行。
;
; 期望：J3 闭合、NE555 为 4810.00481000481 Hz 时，名义门宽 1 s（10000 × 100 µs = 1000 ms），
; T0 约 4809/4810。若中断入口的 2 个系统时钟没有进入外设时间账本，完成时刻会多约 1.667 ms，
; T0 约 4818。

ORG 0x0000
LJMP start

ORG 0x001b
LJMP timer1_isr

ORG 0x0030
start:
  MOV AUXR,#0xC0        ; T0/T1 1T
  MOV TMOD,#0x04        ; T0 计数方式、T1 模式 0
  MOV TH0,#0x00
  MOV TL0,#0x00
  MOV TH1,#0xFB         ; T1 重装 0xFB50 -> 100 µs @ 12 MHz
  MOV TL1,#0x50
  MOV 0x30,#0x00        ; 中断计数低字节
  MOV 0x31,#0x00        ; 中断计数高字节
  MOV 0x32,#0x00        ; done
  MOV 0x33,#0x00        ; T0 低字节
  MOV 0x34,#0x00        ; T0 高字节
  SETB TR0              ; 开始对 P3.4 下降沿计数
  SETB IE.3             ; ET1
  SETB EA
  SETB TR1              ; 启动 100 µs 门控节拍
main:
  INC 0x40
  SJMP main

timer1_isr:
  INC 0x30
  MOV A,0x30
  JNZ check
  INC 0x31
check:
  MOV A,0x31
  XRL A,#0x27
  JNZ done
  MOV A,0x30
  XRL A,#0x10
  JNZ done
  MOV A,TL0
  MOV 0x33,A
  MOV A,TH0
  MOV 0x34,A
  MOV 0x32,#0x01
  CLR TR0
  CLR TR1
done:
  RETI
