.syntax unified
.thumb
.text
start:

    movw r0, #0x1000
    movt r0, #0x4002
    @ HSE on, but no crystal is populated in the model
    ldr r1, [r0, #0x00]
    movw r2, #0x0000
    movt r2, #0x0001
    orrs r1, r1, r2
    str r1, [r0, #0x00]
    movs r1, #2
    str r1, [r0, #0x08]       @ request HSE
    @ request PLL while PLL is still off
    movs r1, #3
    str r1, [r0, #0x08]
    ldr r2, [r0, #0x08]
    ldr r3, [r0, #0x00]
    movw r5, #0x0000
    movt r5, #0x2000
    str r2, [r5, #0x00]
    str r3, [r5, #0x04]
done:
    b done

.pool
