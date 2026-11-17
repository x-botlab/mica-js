@ 真实看门狗超时后读 RCC_CSR（合成复位源标志）并验证 RMVF。
@ 0x400 = 启动次数，0x404 = 首次已启动 WDG，0x408 = 复位后 CSR，0x40c = RMVF 后 CSR。
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
    bne after_reset

.ifdef WWDG
    ldr r0, =0x40002c00      @ WWDG
    movs r1, #0x7f
    str r1, [r0, #4]         @ CFR: WDGTB=0, W=0x7f
    movs r1, #0xc0           @ WDGA=1, T=0x40 -> 下一 tick 复位
    str r1, [r0, #0]
.else
    ldr r0, =0x40003000      @ IWDG
    ldr r1, =0x5555
    str r1, [r0, #0]         @ KR unlock
    movs r1, #0
    str r1, [r0, #4]         @ PR /4
    str r1, [r0, #8]         @ RLR = 0 -> 1 tick
    ldr r1, =0xcccc
    str r1, [r0, #0]         @ start
.endif

    ldr r1, =0x20000404
    movs r2, #1
    str r2, [r1]
1:  b 1b

after_reset:
    ldr r0, =0x40021094      @ RCC_CSR
    ldr r1, [r0]
    ldr r2, =0x20000408
    str r1, [r2]

    ldr r1, =0x00800000      @ RMVF
    str r1, [r0]
    ldr r1, [r0]
    str r1, [r2, #4]

1:  b 1b

.ltorg
