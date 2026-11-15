.syntax unified
.thumb
.section .text
.word 0x20005800
.word 0x08000009

start:
    movw r0, #0x1000
    movt r0, #0x4002
    movs r1, #1
    str r1, [r0, #0x48]       @ RCC->AHB2ENR: GPIOA clock
    movw r0, #0x0000
    movt r0, #0x4800          @ GPIOA
    movw r1, #0x4400
    movt r1, #0x0001          @ PA5/PA7/PA8 output; PA6 input
    str r1, [r0, #0]
    movw r1, #0x9800          @ PA5 pull-down, PA6 pull-up, PA7 pull-down
    str r1, [r0, #0x0c]       @ PUPDR
    movw r1, #0x01a0          @ PA5/PA7/PA8 high
    str r1, [r0, #0x14]       @ ODR
    movw r1, #0x4000
    movt r1, #0x0001          @ PA5 input, preserve PA7/PA8 output
    str r1, [r0, #0]
    movs r1, #0x80            @ PA7 open-drain, preserve all other pins
    str r1, [r0, #0x04]       @ OTYPER
loop:
    b loop
