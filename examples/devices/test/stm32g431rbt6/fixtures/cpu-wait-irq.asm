.syntax unified
.thumb
.section .text
.word 0x20005800
.word reset+1
.space 0x34
.word systick+1
.thumb_func
reset:
    /* RCC AHB2ENR: GPIOAEN | DAC1EN */
    movw r0, #0x104c
    movt r0, #0x4002
    movw r1, #0x0001
    movt r1, #0x0001
    str r1, [r0]

    /* PA0 output */
    movw r0, #0x0000
    movt r0, #0x4800
    movs r1, #1
    str r1, [r0]

    /* SysTick 1 ms @16 MHz: LOAD=15999, VAL=0, CTRL=ENABLE|TICKINT|CLKSOURCE */
    movw r0, #0xe010
    movt r0, #0xe000
    movw r1, #0x3e7f
    movt r1, #0x0000
    str r1, [r0, #4]
    movs r1, #0
    str r1, [r0, #8]
    movs r1, #7
    str r1, [r0, #0]

    /* DAC1 CR.EN1=1: 10 us refresh, no interrupt */
    movw r0, #0x0800
    movt r0, #0x5000
    movs r1, #1
    str r1, [r0]

loop:
    wfi
    /* afterWait marker: must stay 0 across pure DAC deadlines */
    movw r0, #0x0000
    movt r0, #0x4800
    movs r1, #1
    str r1, [r0, #0x14]
    /* stop DAC refresh after the IRQ wake so the board can settle */
    movw r0, #0x0800
    movt r0, #0x5000
    movs r1, #0
    str r1, [r0]
1:  b 1b

.org 0x100
.thumb_func
systick:
    bx lr
