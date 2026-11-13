; CT107D 演示固件：8 位数码管全亮扫描 + 8 路 LED 走马灯
;
; 片选（P2.7/P2.6/P2.5 → 74HC138 的 C/B/A，Y4–Y7 再经 74HC02 与 WR 或非得到 LE）：
;   P2 = 0x80 → Y4# → U6：8 路 LED（D1–D8），输出低电平点亮
;   P2 = 0xC0 → Y6# → U8：数码管位选 com1–com8，低电平选中该位
;   P2 = 0xE0 → Y7# → U7：数码管段码 a–dp（0xFF = 七段 + 小数点全亮）
;
; 每个锁存的写入顺序都固定为「P0 放数据 → P2 抬高 LE（透明跟随）→ 保持一个 DELAY → P2 归零（下降沿锁存）」。
; 74HC573 只在电气采样点看到 LE 电平，脉冲宽度必须大于采样间隔，因此把本来就有的延时
; 放在 LE 保持高电平期间：数码管位的显示时间与锁存共用同一个 DELAY，不增加帧时长。
; 段码只写一次，之后一直由 U7 的锁存保持；扫描过程只改位选，所以 8 位都显示「8.」。
;
; 延时按 12 MHz、1T 内核（原理图 clockFrequency = 12_000_000）计算：每位约 2.9k 个时钟
; （约 244 µs），一帧 8 位约 23k 时钟（约 1.95 ms）；LED 锁存每帧再加一个 DELAY（约 244 µs），
; 每 8 帧把 LED 图案左移一位（约 17.6 ms），走马灯一圈约 141 ms。
; DELAY 用 44 × 12 的嵌套循环，把 1 MHz 版本 44 次内层回跳放大 12 倍，可见节奏与
; 1 MHz 演示逐项一致；改回 11.0592 MHz 时把 R0 调到 11 即可（44 × 11 ≈ 484 次）。

        ORG 0
        LJMP INIT

INIT:
        MOV P0M0,#0FFH        ; P0 推挽输出（数据总线）
        MOV P0M1,#00H
        MOV P2M0,#0E0H        ; P2.5–P2.7 推挽输出（片选）
        MOV P2M1,#00H

        MOV P0,#0FFH          ; 段码：a–g 与 dp 全亮
        MOV P2,#0E0H          ; Y7# → U7 透明
        ACALL DELAY           ; LE 保持高：让电气采样看到透明相位
        MOV P2,#00H           ; 下降沿锁存

        MOV R7,#0FEH          ; LED 图案：bit0 = D1，低电平点亮
        MOV R2,#8             ; 每 8 帧移动一位

MAIN:
        MOV P0,R7             ; 刷新 LED 锁存
        MOV P2,#80H           ; Y4# → U6 透明
        ACALL DELAY           ; LE 保持高：让电气采样看到透明相位
        MOV P2,#00H           ; 下降沿锁存

        MOV R6,#8             ; 8 个数码管位
        MOV R5,#0FEH          ; com1 低，其余高
DIGIT:
        MOV P0,R5             ; 位选
        MOV P2,#0C0H          ; Y6# → U8 透明
        ACALL DELAY           ; 显示该位，同时让电气采样看到透明相位
        MOV P2,#00H           ; 下降沿锁存
        MOV A,R5
        RL A                  ; 移到下一位
        MOV R5,A
        DJNZ R6,DIGIT

        DJNZ R2,MAIN          ; 未到移动时刻，继续扫描
        MOV R2,#8
        MOV A,R7
        RL A                  ; 走马灯左移
        MOV R7,A
        SJMP MAIN

DELAY:                        ; 约 2.9k 个时钟，约 244 µs（12 MHz、1T）
        MOV R1,#44            ; 外层：44 轮
OUTER:
        MOV R0,#12            ; 内层：每轮 12 次回跳，合计 528 次
WAIT:
        NOP
        DJNZ R0,WAIT
        DJNZ R1,OUTER
        RET
