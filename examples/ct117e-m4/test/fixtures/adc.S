@ CT117E-M4 ADC: PB12 -> ADC1_IN11 (R38), PB15 -> ADC2_IN15 (R37).
@ Wait for B1 so the host can load both potentiometers before the first conversion.
@ Each loop resamples both channels; results land in SRAM[0] and SRAM[4].
@ VREFP/VDDA are the fused 3.3 V references supplied by model.ddl.

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
    movs r1, #2                 @ GPIOB clock
    str r1, [r0, #0x4c]

    ldr r0, =0x48000400
    ldr r1, =0xcf000000         @ PB12/PB15 analog
    str r1, [r0, #0x00]

wait_button:
    ldr r1, [r0, #0x10]         @ B1 = PB0
    ands r1, r1, #1
    bne wait_button

    ldr r4, =0x50000000         @ ADC1
    ldr r5, =0x50000100         @ ADC2
    ldr r6, =0x20000000

    ldr r1, =0x10000000         @ ADVREGEN
    str r1, [r4, #0x08]
    ldr r1, =0x10000001         @ ADEN
    str r1, [r4, #0x08]
    ldr r1, =0x000002c0         @ SQR1: IN11, length 1
    str r1, [r4, #0x30]

    ldr r1, =0x10000000
    str r1, [r5, #0x08]
    ldr r1, =0x10000001
    str r1, [r5, #0x08]
    ldr r1, =0x000003c0         @ SQR1: IN15, length 1
    str r1, [r5, #0x30]

loop:
    ldr r1, =0x10000004         @ ADC1 ADSTART
    str r1, [r4, #0x08]
wait1:
    ldr r1, [r4, #0x00]
    ands r1, r1, #4             @ EOC
    beq wait1
    ldr r0, [r4, #0x40]
    str r0, [r6]

    ldr r1, =0x10000004         @ ADC2 ADSTART
    str r1, [r5, #0x08]
wait2:
    ldr r1, [r5, #0x00]
    ands r1, r1, #4
    beq wait2
    ldr r0, [r5, #0x40]
    str r0, [r6, #4]
    b loop
