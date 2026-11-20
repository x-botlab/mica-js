.syntax unified
.thumb
.section .text
.word 0x20005800
.word reset+1
.space 0x34
.word systick+1
.thumb_func
reset:
    movw r0, #0x1000
    movt r0, #0x4002
    movs r1, #1
    str r1, [r0, #0x4c]      /* RCC AHB2ENR GPIOAEN */
    movw r0, #0x0000
    movt r0, #0x4800
    movs r1, #5
    str r1, [r0, #0]         /* PA0/PA1 output */
    movw r0, #0xe010
    movt r0, #0xe000
    movw r1, #0x3e7f
    movt r1, #0x0000
    str r1, [r0, #4]         /* LOAD 15999 */
    movs r1, #0
    str r1, [r0, #8]
    movs r1, #7
    str r1, [r0, #0]         /* ENABLE|TICKINT|CLKSOURCE */
    movw r4, #0x0000
    movt r4, #0x2000
    movs r5, #0
    str r5, [r4]             /* counter */
loop:
    wfi
    ldr r1, [r4]
    adds r1, #1
    str r1, [r4]
    cmp r1, #3
    bne loop
    movw r0, #0x0000
    movt r0, #0x4800
    str r1, [r0, #0x14]
1:  b 1b

.org 0x100
.thumb_func
systick:
    bx lr
