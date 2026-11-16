
start:
    movw r0, #0x1000
    movt r0, #0x4002
    movs r1, #1
    str r1, [r0, #0x48]
    movw r0, #0x0000
    movt r0, #0x4800
    movw r1, #0x0400
    str r1, [r0, #0]
loop:
    movs r1, #0x20
    str r1, [r0, #0x14]
    bl delay
    movs r1, #0
    str r1, [r0, #0x14]
    bl delay
    b loop
delay:
    movw r2, #0x00ff
dloop:
    subs r2, r2, #1
    bne dloop
    bx lr
