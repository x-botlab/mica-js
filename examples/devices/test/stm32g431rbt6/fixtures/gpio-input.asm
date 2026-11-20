
start:
    movw r0, #0x1000
    movt r0, #0x4002
    movs r1, #1
    str r1, [r0, #0x4c]       @ RCC AHB2ENR: GPIOAEN
    movw r0, #0x0000
    movt r0, #0x4800
    movs r1, #4
    str r1, [r0, #0]
    movs r1, #2
    str r1, [r0, #0x0c]
loop:
    ldr r1, [r0, #0x10]
    ands r1, r1, #1
    lsls r1, r1, #1
    str r1, [r0, #0x14]
    b loop
