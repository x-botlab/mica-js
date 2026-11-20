.syntax unified
.thumb
.include "usart-common.inc"

USART_VECTORS default_handler

.thumb_func
reset:
    USART1_INIT 0x0d
    ldr r0, =0x40013800
.wait_ore:
    ldr r2, [r0, #0x1c]
    tst r2, #0x08                    @ ORE
    beq .wait_ore
    ldr r3, [r0, #0x24]              @ RDR（第二个字节）
    and r2, r2, #0x28                @ 只保留 ORE|RXNE
.wait_txe1:
    ldr r4, [r0, #0x1c]
    tst r4, #0x80
    beq .wait_txe1
    str r2, [r0, #0x28]              @ 状态字节
.wait_txe2:
    ldr r4, [r0, #0x1c]
    tst r4, #0x80
    beq .wait_txe2
    str r3, [r0, #0x28]              @ 第二个字节
    movs r4, #0x08
    str r4, [r0, #0x20]              @ ICR.ORECF
.loop:
    b .loop

DEFAULT_HANDLER
