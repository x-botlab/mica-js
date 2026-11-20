.syntax unified
.thumb
.include "usart-common.inc"

USART_VECTORS default_handler

.thumb_func
reset:
    @ 两路 1 Mbaud RX 同时活动；tick 必须取两路真实采样期限的最小值。
    USART1_INIT 0x0d, 16
    USART2_INIT 0x0d, 16
    ldr r5, =0x40013800
    ldr r6, =0x40004400
.loop:
    ldr r2, [r5, #0x1c]
    tst r2, #0x20
    beq .check2
    ldr r2, [r5, #0x24]
    str r2, [r5, #0x28]
.check2:
    ldr r2, [r6, #0x1c]
    tst r2, #0x20
    beq .loop
    ldr r2, [r6, #0x24]
    str r2, [r6, #0x28]
    b .loop

DEFAULT_HANDLER
