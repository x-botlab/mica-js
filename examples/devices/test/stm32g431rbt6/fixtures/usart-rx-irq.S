.syntax unified
.thumb
.include "usart-common.inc"

USART_VECTORS usart1_handler

.thumb_func
reset:
    USART1_INIT 0x2d                 @ UE|RE|TE|RXNEIE
    USART1_NVIC
    ldr r0, =0x40013800
.loop:
    b .loop

.thumb_func
usart1_handler:
    push {r0-r3, lr}
    ldr r0, =0x40013800
    ldr r1, [r0, #0x24]              @ RDR 读清 RXNE
    str r1, [r0, #0x28]              @ 回显
    pop {r0-r3, lr}
    bx lr

DEFAULT_HANDLER
