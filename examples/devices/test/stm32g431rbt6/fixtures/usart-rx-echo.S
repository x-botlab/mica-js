.syntax unified
.thumb
.include "usart-common.inc"

USART_VECTORS default_handler

.thumb_func
reset:
    USART1_INIT 0x0d
    ldr r0, =0x40013800
.wait_rx:
    ldr r1, [r0, #0x1c]
    tst r1, #0x20
    beq .wait_rx
    ldr r1, [r0, #0x24]
    str r1, [r0, #0x28]
    b .wait_rx

DEFAULT_HANDLER
