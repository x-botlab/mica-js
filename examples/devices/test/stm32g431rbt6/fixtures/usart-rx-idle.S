.syntax unified
.thumb
.include "usart-common.inc"

USART_VECTORS usart1_handler

.thumb_func
reset:
    USART1_INIT 0x1d                 @ UE|RE|TE|IDLEIE
    USART1_NVIC
    ldr r0, =0x40013800
.loop:
    b .loop

.thumb_func
usart1_handler:
    cpsid i
    push {r0-r3, lr}
    ldr r0, =0x40013800
    ldr r1, [r0, #0x24]              @ RDR
    movs r2, #0x10                   @ ICR.IDLECF
    str r2, [r0, #0x20]
    ldr r2, [r0, #0]                 @ CR1
    bic r2, r2, #0x10                @ 关 IDLEIE，避免 ICR 延迟时重入
    str r2, [r0, #0]
    movs r1, #0x49                   @ 'I'
    str r1, [r0, #0x28]              @ 用发送事件确认中断已处理
    pop {r0-r3, lr}
    cpsie i
    bx lr

DEFAULT_HANDLER
