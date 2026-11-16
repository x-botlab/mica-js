
start:
    movw r0, #0x1000
    movt r0, #0x4002
    movs r1, #1
    str r1, [r0, #0x48]
    movw r0, #0x0000
    movt r0, #0x4800
    movw r1, #0x0400
    str r1, [r0, #0]
    movw r0, #0xe010
    movt r0, #0xe000
    movw r1, #0x3e7f
    movt r1, #0x0000
    str r1, [r0, #4]
    movs r1, #0
    str r1, [r0, #8]
    movs r1, #7
    str r1, [r0, #0]
loop:
    b loop
