.syntax unified
.thumb

.section .isr_vector,"a",%progbits
.word 0x20005800
.word reset + 1
.rept 35
.word default_handler + 1
.endr
.word fdcan_it0 + 1
.word default_handler + 1
.rept 79
.word default_handler + 1
.endr

.section .text
.thumb_func
reset:
    @ RCC_APB1ENR1.FDCANEN
    ldr r0, =0x40021000
    ldr r1, [r0, #0x58]
    ldr r2, =0x02000000
    orrs r1, r1, r2
    str r1, [r0, #0x58]
    ldr r0, =0x40006400
    movs r1, #3
    str r1, [r0, #0x18]       @ CCCR = INIT|CCE
    ldr r1, =0x00000b02       @ 16 MHz / 16 tq = 1 Mbit/s
    str r1, [r0, #0x1c]       @ NBTP
    movs r1, #0x10
    str r1, [r0, #0x10]       @ TEST.LBCK
    movs r1, #0xa3
    str r1, [r0, #0x18]       @ INIT|CCE|TEST|MON
    ldr r0, =0x4000a400
    ldr r1, =0x892307ff       @ filter0: classic mask, 0x123/0x7ff -> FIFO0
    str r1, [r0]

    ldr r0, =0x40006400
    movw r1, #0
    movt r1, #1
    str r1, [r0, #0x80]       @ RXGFC.LSS=1, ANFS=FIFO0
    movs r1, #0xa0
    str r1, [r0, #0x18]       @ leave INIT/CCE, keep TEST|MON
    movs r1, #0x81
    str r1, [r0, #0x54]       @ IE = RF0NE|TCE
    movs r1, #1
    str r1, [r0, #0x5c]       @ ILE.EINT0
    ldr r0, =0xe000e100
    movs r1, #1
    lsls r1, r1, #21          @ IRQ21
    str r1, [r0]
    ldr r0, =0x4000a400
    ldr r1, =0x048c0000       @ T0: std ID 0x123
    str r1, [r0, #0x278]
    movs r1, #8
    lsls r1, r1, #16          @ DLC=8
    str r1, [r0, #0x27c]
    ldr r1, =0x44332211
    str r1, [r0, #0x280]
    ldr r1, =0x88776655
    str r1, [r0, #0x284]
    ldr r0, =0x40006400
    movs r1, #1
    str r1, [r0, #0xcc]       @ TXBAR buffer0

loop:
    b loop

.thumb_func
fdcan_it0:
    push {r4, r5}
    ldr r0, =0x40006400
    ldr r1, [r0, #0x50]       @ IR
    ldr r2, =0x20004000
    str r1, [r2, #4]
    ldr r3, [r0, #0x90]       @ RXF0S
    str r3, [r2, #8]
    ldr r3, [r0, #0xd4]       @ TXBTO
    str r3, [r2, #0x0c]
    ldr r3, =0x4000a400
    ldr r4, [r3, #0x0b0]
    str r4, [r2, #0x10]
    ldr r4, [r3, #0x0b4]
    str r4, [r2, #0x14]
    ldr r4, [r3, #0x0b8]
    str r4, [r2, #0x18]
    ldr r4, [r3, #0x0bc]
    str r4, [r2, #0x1c]

    ldr r4, =0xffffffff
    str r4, [r0, #0x50]       @ IR W1C
    movs r4, #0
    str r4, [r0, #0x94]       @ RXF0A acknowledge index 0

    movs r5, #1
    str r5, [r2]
    ldr r5, [r2, #0x20]
    adds r5, r5, #1
    str r5, [r2, #0x20]
    pop {r4, r5}
    bx lr

.thumb_func
default_handler:
    b default_handler

.pool
