.syntax unified
.thumb
.include "usart-common.inc"

USART_VECTORS usart1_handler

.thumb_func
reset:
    USART1_INIT 0x2d                 @ UE|RE|TE|RXNEIE；错误另由 EIE 触发
    ldr r0, =0x40013800
    movs r1, #1
    str r1, [r0, #0x08]              @ CR3.EIE
    USART1_NVIC
.loop:
    b .loop

.thumb_func
usart1_handler:
    cpsid i
    push {r0-r4, lr}
    ldr r0, =0x40013800
    ldr r1, [r0, #0x1c]              @ ISR 低字节（FE/NE/ORE/IDLE）
    and r1, r1, #0x3e                @ 去掉 TXE/TC 等发送标志
    ldr r2, [r0, #0x24]              @ RDR
    str r1, [r0, #0x28]              @ 先发状态字节
    movs r3, #0x1e                   @ ICR: FECF|NCF|ORECF|IDLECF
    str r3, [r0, #0x20]
    movs r3, #0
    str r3, [r0, #0x08]              @ 关 CR3.EIE，避免延迟清除期间重入
    str r2, [r0, #0x28]              @ 再发数据字节
    pop {r0-r4, lr}
    cpsie i
    bx lr

DEFAULT_HANDLER
