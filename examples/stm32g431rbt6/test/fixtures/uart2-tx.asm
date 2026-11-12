
start:
    movw r0, #0x1000
    movt r0, #0x4002
    movs r1, #1
    str r1, [r0, #0x48]
    movw r1, #0x0002
    movt r1, #0x0002
    str r1, [r0, #0x58]
    movw r0, #0x0000
    movt r0, #0x4800
    movs r1, #0x20
    str r1, [r0, #0]
    movw r1, #0x0700
    str r1, [r0, #0x20]
    movw r0, #0x4400
    movt r0, #0x4000
    movs r1, #0x8b
    str r1, [r0, #0x0c]
    movs r1, #9
    str r1, [r0, #0]
    movs r1, #0x4f
    str r1, [r0, #0x28]
    movs r1, #0x4b
    str r1, [r0, #0x28]
loop:
    b loop
