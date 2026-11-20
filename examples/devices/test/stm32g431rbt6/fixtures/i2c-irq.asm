@ STM32G431RBT6 I2C1 错误中断 IRQ32 固件夹具。
@
@ PB8/PB7 AF4；向未挂接地址 0x7E 发起写事务，I2C1_ER_IRQn=32（ISER1 bit0）
@ 应进入 NACK 处理程序。处理程序写 SRAM 0x20000000=1 并清 NACKF/STOPF。

    .syntax unified
    .cpu cortex-m4
    .thumb

    .section .vectors, "a", %progbits
    .word 0x20005800
    .word reset + 1
    .space (48 - 2) * 4, 0
    .word nack_handler + 1

    .section .text
    .thumb_func
reset:
    ldr r0, =0x40021000
    movs r1, #1
    str r1, [r0, #0x4c]          @ AHB2ENR: GPIOB
    movs r1, #1
    lsls r1, r1, #21
    str r1, [r0, #0x58]          @ APB1ENR1: I2C1EN

    ldr r0, =0x48000400
    ldr r1, =0x00028000
    str r1, [r0, #0x00]          @ PB7/PB8 AF
    movs r1, #0x180
    str r1, [r0, #0x04]          @ open-drain
    movs r1, #0
    str r1, [r0, #0x0C]
    ldr r1, =0x40000000
    str r1, [r0, #0x20]          @ PB7 AF4
    movs r1, #4
    str r1, [r0, #0x24]          @ PB8 AF4

    ldr r0, =0x40005400
    ldr r1, =0x00304F4F
    str r1, [r0, #0x10]
    movs r1, #0x11               @ PE | NACKIE
    str r1, [r0, #0x00]

    ldr r0, =0xE000E104          @ NVIC ISER1: IRQ32
    movs r1, #1
    str r1, [r0]

    ldr r0, =0x40005400
    ldr r1, =0x020120FC          @ SADD 0x7E,W NBYTES=1 START AUTOEND
    str r1, [r0, #0x04]
loop:
    b loop

    .thumb_func
nack_handler:
    push {r0, r1}
    ldr r0, =0x20000000
    movs r1, #1
    str r1, [r0]
    ldr r0, =0x40005400
    movs r1, #0x10               @ NACKCF
    str r1, [r0, #0x1C]
    movs r1, #0x20               @ STOPCF
    str r1, [r0, #0x1C]
    pop {r0, r1}
    bx lr
