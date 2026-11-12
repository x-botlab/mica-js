; CT107D 演示固件：8 位数码管全亮扫描 + 8 路 LED 走马灯
;
; 片选（P2.7/P2.6/P2.5 → 74HC138 的 C/B/A，Y4–Y7 再经 74HC02 与 WR 或非得到 LE）：
;   P2 = 0x80 → Y4# → U6：8 路 LED（D1–D8），输出低电平点亮
;   P2 = 0xC0 → Y6# → U8：数码管位选 com1–com8，低电平选中该位
;   P2 = 0xE0 → Y7# → U7：数码管段码 a–dp（0xFF = 七段 + 小数点全亮）
;
; 每个锁存的写入顺序都固定为「P0 放数据 → P2 抬高 LE（透明跟随）→ P2 归零（下降沿锁存）」。
; 段码只写一次，之后一直由 U7 的锁存保持；扫描过程只改位选，所以 8 位都显示「8.」。
;
; 延时按 1 MHz、1T 内核（原理图 clockFrequency = 1_000_000）计算：每位约 226 个时钟
; （约 226 µs），一帧 8 位约 1.9k 时钟（约 1.9 ms）；每 8 帧把 LED 图案左移一位
; （约 15 ms），走马灯一圈约 120 ms。
; 备注：原来的约 20 µs 目标属于 11.0592 MHz；在 1 MHz 下若要同样的 20 µs，R1 需降到
; 约 4。演示为了预览性能固定跑 1 MHz，所以保留 R1=44。

        ORG 0
        LJMP INIT

INIT:
        MOV P0M0,#0FFH        ; P0 推挽输出（数据总线）
        MOV P0M1,#00H
        MOV P2M0,#0E0H        ; P2.5–P2.7 推挽输出（片选）
        MOV P2M1,#00H

        MOV P0,#0FFH          ; 段码：a–g 与 dp 全亮
        MOV P2,#0E0H          ; Y7# → U7 透明
        MOV P2,#00H           ; 下降沿锁存

        MOV R7,#0FEH          ; LED 图案：bit0 = D1，低电平点亮
        MOV R2,#8             ; 每 8 帧移动一位

MAIN:
        MOV P0,R7             ; 刷新 LED 锁存
        MOV P2,#80H           ; Y4# → U6
        MOV P2,#00H

        MOV R6,#8             ; 8 个数码管位
        MOV R5,#0FEH          ; com1 低，其余高
DIGIT:
        MOV P0,R5             ; 位选
        MOV P2,#0C0H          ; Y6# → U8
        MOV P2,#00H
        ACALL DELAY
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

DELAY:                        ; 约 226 个时钟，约 226 µs（1 MHz、1T）
        MOV R1,#44
WAIT:
        NOP
        DJNZ R1,WAIT
        RET
