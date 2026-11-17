.syntax unified
.thumb
.include "usart-common.inc"

USART_VECTORS default_handler

.thumb_func
reset:
    USART1_INIT 0x0d
    ldr r0, =0x40013800
    movs r1, #0x55
    str r1, [r0, #0x28]
    movs r1, #0xa6
    str r1, [r0, #0x28]
.loop:
    b .loop

DEFAULT_HANDLER
