.syntax unified
.thumb
.include "usart-common.inc"

USART_VECTORS default_handler

.thumb_func
reset:
    USART1_INIT 0x0d
    ldr r0, =0x40013800
    movs r1, #0x5a                   @ 'Z'
    str r1, [r0, #0x28]
.wait_rx:
    ldr r2, [r0, #0x1c]
    tst r2, #0x20
    beq .wait_rx
    ldr r2, [r0, #0x24]              @ 读回环字节
    cmp r2, #0x5a
    bne .mismatch
    movs r1, #0x59                   @ 匹配才回 'Y'
    b .send
.mismatch:
    movs r1, #0x4e                   @ 不匹配回 'N'
.send:
    str r1, [r0, #0x28]
.loop:
    b .loop

DEFAULT_HANDLER
