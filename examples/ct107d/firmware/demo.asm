; CT107D 演示固件：8 位数码管全亮 + 8 路 LED 走马灯
;
; 片选（P2.7/P2.6/P2.5 → 74HC138 的 C/B/A，Y4–Y7 再经 74HC02 与 WR 或非得到 LE）：
;   P2 = 0x80 → Y4# → U6：8 路 LED（D1–D8），输出低电平点亮
;   P2 = 0xC0 → Y6# → U8：数码管位选 com1–com8，高电平选中（共阳），0xFF = 八位全选
;   P2 = 0xE0 → Y7# → U7：数码管段码 a–dp（0x00 = 七段 + 小数点全亮，共阳低电平点亮）
;
; 上电把段码与位选各锁存一次，之后不再改动；主循环只刷新 LED 锁存并逐步左移图案。
; 74HC573 只在电气采样点看到 LE 电平，所以每次锁存都把 LE 保持高电平一个完整 DELAY
; （实测约 4 ms，不短于整板预览的 2 ms 推进步长），保证至少有一次采样落在透明相位。
; 两次刷新之间 P0 一直等于 LED 图案，因此粗粒度推进也不会把别的数据锁存进 U6；
; 逐位扫描链路由 verify-schematic.mjs 的专用固件与用例覆盖。
;
; 延时按 12 MHz、1T 内核（原理图 clockFrequency = 12_000_000）计算：44 × 200 次内层
; 回跳约 26.4k 个时钟；一步走马灯约 4 个 DELAY，一圈约 130 ms。改回 11.0592 MHz 时
; 节奏略慢一些（实测每个 DELAY 约 4 ms），不影响可见性。

        ORG 0
        LJMP INIT

INIT:
        MOV P0M0,#0FFH        ; P0 推挽输出（数据总线）
        MOV P0M1,#00H
        MOV P2M0,#0E0H        ; P2.5–P2.7 推挽输出（片选）
        MOV P2M1,#00H

        MOV P0,#00H           ; 段码：a–g 与 dp 全亮（共阳：低电平点亮）
        MOV P2,#0E0H          ; Y7# → U7 透明
        ACALL DELAY           ; LE 保持高：让电气采样看到透明相位
        MOV P2,#00H           ; 下降沿锁存

        MOV P0,#0FFH          ; 位选：八位全选（共阳：高电平选中）
        MOV P2,#0C0H          ; Y6# → U8 透明
        ACALL DELAY           ; LE 保持高：让电气采样看到透明相位
        MOV P2,#00H           ; 下降沿锁存

        MOV R7,#0FEH          ; LED 图案：bit0 = D1，低电平点亮

MAIN:
        MOV P0,R7             ; 刷新 LED 锁存
        MOV P2,#80H           ; Y4# → U6 透明
        ACALL DELAY           ; LE 保持高：让电气采样看到透明相位
        MOV P2,#00H           ; 下降沿锁存

        ACALL DELAY           ; 停留：P0 保持 LED 图案
        ACALL DELAY
        ACALL DELAY

        MOV A,R7
        RL A                  ; 走马灯左移
        MOV R7,A
        SJMP MAIN

DELAY:                        ; 约 26.4k 个时钟（12 MHz 下名义 2.2 ms，实测约 4 ms）
        MOV R1,#44            ; 外层：44 轮
OUTER:
        MOV R0,#200           ; 内层：每轮 200 次回跳，合计 8800 次
WAIT:
        NOP
        DJNZ R0,WAIT
        DJNZ R1,OUTER
        RET
