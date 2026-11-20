.syntax unified
.thumb
.section .text
.word 0x20005800
.word 0x08000009

start:
    movw r0, #0x1000
    movt r0, #0x4002
    movs r1, #1
    str r1, [r0, #0x4c]       @ RCC->AHB2ENR: GPIOA clock
    movw r0, #0x0000
    movt r0, #0x4800          @ GPIOA
    movw r1, #0x5400          @ PA5/PA6/PA7 push-pull output
    str r1, [r0, #0]
    movs r1, #0x60            @ set PA5 and PA6
    strh r1, [r0, #0x18]      @ BSRR low half: set PA5/PA6
    movw r1, #0x00a0
    movt r1, #0x0060          @ set PA5(high, conflict), reset PA5, set PA7(low, conflict), reset PA6
    str r1, [r0, #0x18]       @ BSRR
loop:
    b loop
