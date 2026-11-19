@ CT117E-M4 ADC idle: configure and enable ADC1/IN11 but never set ADSTART.
@ DR must stay 0; no random or fabricated sample may appear.

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
    movs r1, #2
    str r1, [r0, #0x4c]

    ldr r0, =0x48000400
    ldr r1, =0x03000000         @ PB12 analog
    str r1, [r0, #0x00]

    ldr r4, =0x50000000
    ldr r1, =0x10000000
    str r1, [r4, #0x08]
    ldr r1, =0x10000001
    str r1, [r4, #0x08]
    ldr r1, =0x000002c0
    str r1, [r4, #0x30]

    ldr r0, [r4, #0x40]
    ldr r6, =0x20000000
    str r0, [r6]

spin:
    b spin
