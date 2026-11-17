.syntax unified
.thumb
.section .text
.word 0x20005800
.word reset+1
.thumb_func
reset:
    movw r6, #0x0000
    movt r6, #0x4800
    movs r1, #5
    str r1, [r6]

    movs r0, #1
    movs r1, #0x55
    cmp r0, #1
    it ne
    movne r1, #1
    cmp r1, #0x55
    bne fail

    movs r0, #1
    cmp r0, #1
    it eq
    moveq r1, #1
    cmp r1, #1
    bne fail

    movs r1, #1
    str r1, [r6, #0x14]
    b done
fail:
    movs r1, #2
    str r1, [r6, #0x14]
done:
    b done
