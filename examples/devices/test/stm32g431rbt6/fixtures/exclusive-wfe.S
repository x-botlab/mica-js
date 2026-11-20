@ 标准主 MCU 固件：LDREX -> 外部 IRQ -> STREX 失败；异常返回 event 让一次 WFE
@ 立即通过并消费，第二次 WFE 无事件阻塞。
@ 结果：0x100=STREX 状态（应 1），0x104=第一次 WFE 后标记 0x11，
@ 0x108=第二次 WFE 后标记（应 0），0x10c=IRQ handler 计数。
.syntax unified
.thumb

.section .isr_vector,"a",%progbits
.word 0x20005800
.word reset + 1
.rept 20
.word default_handler + 1
.endr
.word irq6_handler + 1      @ IRQ6 -> exception 22
.rept 97
.word default_handler + 1
.endr

.section .text
.thumb_func
default_handler:
    b default_handler

.thumb_func
reset:
    ldr r0, =0x20000500
    movs r1, #0x55
    str r1, [r0]             @ data
    ldrex r1, [r0]
    ldr r2, =0x20000100

    ldr r3, =0xe000e100      @ NVIC ISER0
    movs r4, #0x40           @ IRQ6
    str r4, [r3]
    ldr r3, =0xe000ef00      @ STIR
    movs r4, #6              @ IRQ6
    str r4, [r3]             @ pend IRQ6; service boundary takes exception

    strex r5, r1, [r0]       @ must fail: exception entry cleared monitor
    str r5, [r2, #0]

    wfe
    movs r6, #0x11
    str r6, [r2, #4]         @ first WFE passes via exception-return event
    wfe
    movs r6, #0x22
    str r6, [r2, #8]         @ second WFE must block
1:  b 1b

.thumb_func
irq6_handler:
    ldr r3, =0x20000100
    ldr r4, [r3, #12]
    adds r4, r4, #1
    str r4, [r3, #12]
    ldr r3, =0xe000e280      @ ICPR0
    movs r4, #0x40
    str r4, [r3]
    bx lr

.ltorg
