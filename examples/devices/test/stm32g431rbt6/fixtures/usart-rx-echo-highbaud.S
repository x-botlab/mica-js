.syntax unified
.thumb
.include "usart-common.inc"

USART_VECTORS default_handler

.thumb_func
reset:
    @ 16 MHz / 1 Mbaud：BRR=16，位周期 1 µs，需要中央把 tick 收紧到 <1 µs。
    USART1_INIT 0x0d, 16
    ldr r0, =0x40013800
.wait_rx:
    ldr r1, [r0, #0x1c]
    tst r1, #0x20
    beq .wait_rx
    ldr r1, [r0, #0x24]
    str r1, [r0, #0x28]
    b .wait_rx

DEFAULT_HANDLER
