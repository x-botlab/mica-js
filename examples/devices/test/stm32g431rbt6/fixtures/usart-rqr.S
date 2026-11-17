.syntax unified
.thumb
.include "usart-common.inc"

USART_VECTORS default_handler

.thumb_func
reset:
    USART1_INIT 0x0d
    ldr r0, =0x40013800
    movs r4, #0

.wait_rx:
    ldr r2, [r0, #0x1c]
    tst r2, #0x20
    beq .wait_rx

    @ RQR lane3 写 0x08 不能清 RXNE。
    movs r2, #8
    strb r2, [r0, #0x1b]
    ldr r3, [r0, #0x1c]
    tst r3, #0x20
    beq .lane3_done
    orr r4, r4, #1
.lane3_done:

    @ RQR lane0 写 0x08 (RXFRQ) 清 RXNE。
    strb r2, [r0, #0x18]
    ldr r3, [r0, #0x1c]
    tst r3, #0x20
    bne .lane0_done
    orr r4, r4, #2
.lane0_done:

.wait_txe:
    ldr r2, [r0, #0x1c]
    tst r2, #0x80
    beq .wait_txe
    strb r4, [r0, #0x28]
.loop:
    b .loop

DEFAULT_HANDLER
