.syntax unified
.thumb
.section .isr_vector,"a",%progbits
.word 0x20005800
.word reset + 1
.rept 117
.word default_handler + 1
.endr
.section .text
.thumb_func
reset:
    ldr r0, =0x20004000
    ldr r1, [r0]
    ldr r2, =0x00005a5a
    cmp r1, r2
    beq after_reset

    str r2, [r0]
    ldr r0, =0x40021000
    ldr r1, [r0, #0x58]
    ldr r2, =0x02000000
    orrs r1, r1, r2
    str r1, [r0, #0x58]
    ldr r0, =0x40006400
    movs r1, #3
    str r1, [r0, #0x18]
    ldr r1, =0x00000b02
    str r1, [r0, #0x1c]
    ldr r0, =0xe000ed0c
    ldr r1, =0x05fa0004
    str r1, [r0]
1:  b 1b

after_reset:
    ldr r0, =0x40006400
    ldr r1, [r0, #0x00]       @ CREL
    ldr r2, =0x20004004
    str r1, [r2]
    ldr r1, [r0, #0x18]       @ CCCR
    str r1, [r2, #4]
    ldr r1, [r0, #0xc4]       @ TXFQS
    str r1, [r2, #8]
    ldr r1, [r0, #0x84]       @ XIDAM
    str r1, [r2, #0x0c]
    movs r1, #1
    str r1, [r2, #0x10]
2:  b 2b

.thumb_func
default_handler:
    b default_handler
.pool
