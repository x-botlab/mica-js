@ 标准主 MCU 固件：WWDG 超时走统一 requestReset sink；第二次启动跳过 WDG。
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

    ldr r0, =0x40002c00      @ WWDG
    movs r1, #0x7f
    str r1, [r0, #4]         @ CFR: WDGTB=0, W=0x7f
    movs r1, #0xc0           @ WDGA=1, T=0x40 -> next tick resets
    str r1, [r0, #0]
    ldr r1, =0x20000404
    movs r2, #1
    str r2, [r1]

done:
1:  b 1b

.ltorg
