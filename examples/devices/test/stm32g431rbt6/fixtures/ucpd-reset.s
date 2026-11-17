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
    ldr r1, [r0, #0x5c]
    orrs r1, r1, #0x100
    str r1, [r0, #0x5c]
    ldr r0, =0x40007000
    ldr r1, [r0, #0x08]
    ldr r2, =0x00004000
    orrs r1, r1, r2
    str r1, [r0, #0x08]
    ldr r0, =0x4000a000
    ldr r1, =0x80000000
    str r1, [r0, #0x00]
    ldr r1, =0x00000e00
    str r1, [r0, #0x0c]
    ldr r1, =0x0000c000
    str r1, [r0, #0x10]
    ldr r0, =0xe000ed0c
    ldr r1, =0x05fa0004
    str r1, [r0]
1:  b 1b

after_reset:
    ldr r0, =0x4000a000
    ldr r1, [r0, #0x00]       @ CFG1
    ldr r2, =0x20004004
    str r1, [r2]
    ldr r1, [r0, #0x0c]       @ CR
    str r1, [r2, #4]
    ldr r1, [r0, #0x10]       @ IMR
    str r1, [r2, #8]
    ldr r1, [r0, #0x14]       @ SR
    str r1, [r2, #0x0c]
    movs r1, #1
    str r1, [r2, #0x10]
2:  b 2b

.thumb_func
default_handler:
    b default_handler
.pool
