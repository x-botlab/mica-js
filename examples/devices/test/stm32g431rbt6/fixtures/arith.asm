
start:
    movw r0, #0x1000
    movt r0, #0x4002
    movs r1, #1
    str r1, [r0, #0x48]
    movw r0, #0x0000
    movt r0, #0x4800
    movw r1, #0x5555
    str r1, [r0, #0]
    movw r1, #0x1234
    movw r2, #0x00f0
    ands r3, r1, r2
    orr.w r3, r3, #0xc0
    ubfx r4, r3, #4, #4
    lsls r4, r4, #4
    eors r3, r4
    cmp r3, #0
    bne fail
    movs r3, #0x30
    str r3, [r0, #0x14]
    b done
fail:
    movs r3, #0xff
    str r3, [r0, #0x14]
done:
    b done
