@ CT117E-M4: LCD read cycle drives PC0-PC15 (index 0 -> 0x9325).
@ With PD2 high the 573 must see the LCD-driven D byte, not the released MCU intents.

    .syntax unified
    .cpu cortex-m4
    .thumb

    .section .isr_vector, "a", %progbits
    .word 0x20005800
    .word reset + 1

    .section .text
    .thumb_func
reset:
    ldr r0, =0x40021000
    movs r1, #0x0f              @ GPIOA/B/C/D clocks
    str r1, [r0, #0x4c]

    ldr r2, =0x48000800
    movs r1, #0                 @ PC0-PC15 input: release D
    str r1, [r2, #0x00]

    ldr r3, =0x48000c00
    movs r1, #0x10              @ PD2 output
    str r1, [r3, #0x00]

    ldr r0, =0x48000400
    ldr r1, =0x00050400         @ PB5/PB8/PB9 output
    str r1, [r0, #0x00]

    ldr r5, =0x48000000
    ldr r1, =0x00010000         @ PA8 output
    str r1, [r5, #0x00]
    movs r6, #0x80
    lsls r6, r6, #1             @ RD high before the read window opens
    str r6, [r5, #0x18]

    ldr r6, =0x02000000         @ CS low (PB9)
    str r6, [r0, #0x18]
    movs r6, #0x80
    lsls r6, r6, #1             @ RS high (PB8): data/register read
    str r6, [r0, #0x18]
    movs r6, #0x20              @ WR high (PB5)
    str r6, [r0, #0x18]
    ldr r6, =0x01000000         @ RD low (PA8): LCD drives 0x9325
    str r6, [r5, #0x18]

    movs r1, #4                 @ PD2 high: transparent, D = LCD data
    str r1, [r3, #0x18]

spin:
    b spin
