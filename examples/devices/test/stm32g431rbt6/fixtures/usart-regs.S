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

    @ 读 RDR 高保留字节：不能清 RXNE，也不能把内部标志当数据。
    ldrb r2, [r0, #0x25]
    ldr r3, [r0, #0x1c]
    tst r3, #0x20
    beq .high_done
    orr r4, r4, #1
.high_done:

    @ 读低字节才清 RXNE。
    ldrb r2, [r0, #0x24]
    ldr r3, [r0, #0x1c]
    tst r3, #0x20
    bne .low_done
    orr r4, r4, #2
.low_done:

    @ 等 IDLE 置位。
.wait_idle:
    ldr r3, [r0, #0x1c]
    tst r3, #0x10
    beq .wait_idle

    @ ICR lane1 写 0x01 -> 映射到 bit8，不能清 IDLE。
    movs r2, #1
    strb r2, [r0, #0x21]
    ldr r3, [r0, #0x1c]
    tst r3, #0x10
    beq .lane1_done
    orr r4, r4, #4
.lane1_done:

    @ ICR lane0 写 0x10 -> 清 IDLE。
    movs r2, #0x10
    strb r2, [r0, #0x20]
    ldr r3, [r0, #0x1c]
    tst r3, #0x10
    bne .lane0_done
    orr r4, r4, #8
.lane0_done:

    @ 保留地址 0x30 读 0；0x30/0x40 的写不能影响 CR1。
    ldr r2, [r0, #0x30]
    cmp r2, #0
    bne .reserved_read_done
    orr r4, r4, #0x10
.reserved_read_done:
    movs r2, #0
    str r2, [r0, #0x30]
    str r2, [r0, #0x40]
    ldr r2, [r0, #0]
    cmp r2, #0x0d
    bne .cr1_done
    orr r4, r4, #0x20
.cr1_done:

.wait_txe:
    ldr r2, [r0, #0x1c]
    tst r2, #0x80
    beq .wait_txe
    strb r4, [r0, #0x28]
.loop:
    b .loop

DEFAULT_HANDLER
