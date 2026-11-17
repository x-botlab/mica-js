.syntax unified
.thumb
.text
start:

    movw r0, #0x1000
    movt r0, #0x4002
    movw r1, #0x0000
    movt r1, #0x1000
    str r1, [r0, #0x58]       @ APB1ENR1.PWREN
    movw r6, #0x7000
    movt r6, #0x4000          @ PWR
    movw r1, #0x0401
    str r1, [r6, #0x00]       @ VOS=Range2, LPMS=Stop1
    ldr r2, [r6, #0x14]       @ SR2
    ldr r3, [r6, #0x00]       @ CR1
    movs r1, #0x1f
    str r1, [r6, #0x18]       @ SCR W1C bits
    ldr r4, [r6, #0x18]
    movw r5, #0x0000
    movt r5, #0x2000
    str r2, [r5, #0x00]
    str r3, [r5, #0x04]
    str r4, [r5, #0x08]
done:
    b done

.pool
