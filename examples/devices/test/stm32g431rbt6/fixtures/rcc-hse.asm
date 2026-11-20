.syntax unified
.thumb
.text
start:

    movw r0, #0x1000
    movt r0, #0x4002
    ldr r1, [r0, #0x00]
    movw r2, #0x0000
    movt r2, #0x0001
    orrs r1, r1, r2
    str r1, [r0, #0x00]       @ HSEON
    @ PLL: HSE, M=3, N=20, PLLREN -> 24/3*20/2 = 80 MHz
    movw r1, #0x1423
    movt r1, #0x0100
    str r1, [r0, #0x0c]
    ldr r1, [r0, #0x00]
    movw r2, #0x0000
    movt r2, #0x0100
    orrs r1, r1, r2
    str r1, [r0, #0x00]       @ PLLON
    movs r1, #3
    str r1, [r0, #0x08]       @ SW=PLL
    ldr r2, [r0, #0x00]
    ldr r3, [r0, #0x08]
    movw r4, #0x0000
    movt r4, #0x2000
    str r2, [r4, #0x00]
    str r3, [r4, #0x04]
done:
    b done

.pool
