@ 标准主 MCU 固件：IWDG 超时走 requestReset sink；第二次启动跳过 WDG。
@ 结果：SRAM 0x400 = 启动次数（应为 2），0x404 = 1（第一次启动已配置）。
.syntax unified
.thumb

.section .isr_vector,"a",%progbits
.word 0x20005800
.word reset + 1
.rept 119
.word default_handler + 1
.endr

.section .text
.thumb_func
default_handler:
    b default_handler

.global reset
.thumb_func
reset:
    ldr r2, =0x20000400
    ldr r1, [r2]
    adds r1, r1, #1
    str r1, [r2]
    cmp r1, #1
    bne done

    ldr r0, =0x40003000      @ IWDG
    ldr r1, =0x5555
    str r1, [r0, #0]         @ KR unlock
    movs r1, #0
    str r1, [r0, #4]         @ PR /4
    str r1, [r0, #8]         @ RLR = 0 -> 1 tick
    ldr r1, =0xcccc
    str r1, [r0, #0]         @ start
    ldr r1, =0x20000404
    movs r2, #1
    str r2, [r1]

done:
1:  b 1b

.ltorg
