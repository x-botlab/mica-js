.syntax unified
.thumb

.section .isr_vector,"a",%progbits
.word 0x20005800
.word reset + 1
.rept 77
.word default_handler + 1
.endr
.word ucpd_irq + 1
.rept 40
.word default_handler + 1
.endr

.section .text
.thumb_func
reset:
    @ RCC: GPIOBEN + PWREN + UCPD1EN
    ldr r0, =0x40021000
    ldr r1, [r0, #0x4c]
    orrs r1, r1, #2
    str r1, [r0, #0x4c]
    ldr r1, [r0, #0x58]
    ldr r2, =0x10000000
    orrs r1, r1, r2
    str r1, [r0, #0x58]
    ldr r1, [r0, #0x5c]
    orrs r1, r1, #0x100
    str r1, [r0, #0x5c]

    @ PWR_CR3.UCPD_DBDIS
    ldr r0, =0x40007000
    ldr r1, [r0, #0x08]
    ldr r2, =0x00004000
    orrs r1, r1, r2
    str r1, [r0, #0x08]

    @ GPIOB PB4/PB6 = analog
    ldr r0, =0x48000400
    ldr r1, [r0]
    ldr r2, =0xffff0cff
    ands r1, r1, r2
    ldr r2, =0x00003300
    orrs r1, r1, r2
    str r1, [r0]

    @ UCPD sink: ANAMODE=1, CCENABLE=3
    ldr r0, =0x4000a000
    ldr r1, =0x80000000
    str r1, [r0, #0x00]       @ CFG1.UCPDEN
    ldr r1, =0x00000e00
    str r1, [r0, #0x0c]       @ CR
    ldr r1, =0x0000c000
    str r1, [r0, #0x10]       @ IMR TYPECEVT1/2
    str r1, [r0, #0x18]       @ clear initial events

    @ NVIC ISER1 bit31 (IRQ63)
    ldr r0, =0xe000e100
    ldr r1, =0x80000000
    str r1, [r0, #4]

loop:
    b loop

.thumb_func
ucpd_irq:
    push {r4, r5}
    ldr r0, =0x4000a000
    ldr r1, [r0, #0x14]       @ SR
    ldr r2, =0x20004000
    str r1, [r2, #4]
    ldr r1, [r0, #0x00]       @ CFG1
    str r1, [r2, #8]
    ldr r1, =0x0000c000
    str r1, [r0, #0x18]       @ ICR clear TYPECEVT1/2
    movs r4, #1
    str r4, [r2]              @ done
    ldr r4, [r2, #0x0c]
    adds r4, r4, #1
    str r4, [r2, #0x0c]       @ IRQ count
    pop {r4, r5}
    bx lr

.thumb_func
default_handler:
    b default_handler

.pool
