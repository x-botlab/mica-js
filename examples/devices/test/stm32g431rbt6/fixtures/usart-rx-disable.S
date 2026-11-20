.syntax unified
.thumb
.include "usart-common.inc"

USART_VECTORS default_handler

.thumb_func
reset:
    USART1_INIT 0x0d
    ldr r0, =0x48000000
.wait_trigger:
    ldr r1, [r0, #0x10]              @ IDR.PA1：测试源在首帧中途拉高
    tst r1, #0x02
    beq .wait_trigger
    ldr r0, =0x40013800
    movs r1, #0x09                   @ UE|TE，关闭 RE：取消半帧
    str r1, [r0, #0]
    movs r1, #0x0d                   @ 重新打开 RE
    str r1, [r0, #0]
.wait_rx:
    ldr r2, [r0, #0x1c]
    tst r2, #0x20
    beq .wait_rx
    ldr r2, [r0, #0x24]
    str r2, [r0, #0x28]
.loop:
    b .loop

DEFAULT_HANDLER
