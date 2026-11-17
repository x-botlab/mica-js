.syntax unified
.thumb
.include "usart-common.inc"

USART_VECTORS default_handler

.thumb_func
reset:
    @ 1 MHz / 200 baud：BRR = 5000，位时长 5 ms（超过 2^32 ps 的 4.295 ms）。
    USART1_INIT 0x0d, 5000
    ldr r0, =0x40013800
.wait_rx:
    ldr r1, [r0, #0x1c]
    tst r1, #0x20
    beq .wait_rx
    ldr r1, [r0, #0x24]
    str r1, [r0, #0x28]
    b .wait_rx

DEFAULT_HANDLER
