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
    ldr r0, =0x40021000
    ldr r1, [r0, #0x4c]
    orrs r1, r1, #2
    str r1, [r0, #0x4c]
    ldr r1, [r0, #0x58]
    ldr r2, =0x10000000
    orrs r1, r1, r2
    str r1, [r0, #0x58]
    ldr r1, [r0, #0x5c]
    orrs r1, r1, #0x100
    str r1, [r0, #0x5c]

    ldr r0, =0x40007000
    ldr r1, [r0, #0x08]
    ldr r2, =0x00004000
    orrs r1, r1, r2
    str r1, [r0, #0x08]

    ldr r0, =0x48000400
    ldr r1, [r0]
    ldr r2, =0xffff0cff
    ands r1, r1, r2
    ldr r2, =0x00003300
    orrs r1, r1, r2
    str r1, [r0]

    ldr r0, =0x4000a000
    ldr r1, =0x80000000
    str r1, [r0, #0x00]
    ldr r1, =0x00000e00
    str r1, [r0, #0x0c]
    ldr r1, =0x0000c000
    str r1, [r0, #0x10]
    str r1, [r0, #0x18]

poll:
    ldr r0, =0x4000a000
    ldr r1, [r0, #0x14]
    mov r3, r1
    lsrs r3, r3, #16
    ands r3, r3, #3
    cmp r3, #2
    bne poll
    tst r1, #0xc000
    beq poll

    ldr r2, =0x20004000
    str r1, [r2, #4]
    ldr r1, [r0, #0x00]
    str r1, [r2, #8]
    ldr r1, =0x0000c000
    str r1, [r0, #0x18]
    movs r3, #1
    str r3, [r2]
    ldr r1, [r0, #0x14]
    str r1, [r2, #0x10]

loop:
    b loop

.thumb_func
default_handler:
    b default_handler

.pool
