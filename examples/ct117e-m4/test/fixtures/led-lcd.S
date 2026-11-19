@ CT117E-M4: latch 0xA5 through PD2, then use the shared PC0-PC15 LCD bus for a
@ full 320x240 GRAM fill (command 0x22, color 0x001F). The closed 573 latch must hold.

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

    ldr r2, =0x48000800         @ GPIOC
    ldr r1, =0x55555555         @ PC0-PC15 output
    str r1, [r2, #0x00]

    ldr r3, =0x48000c00         @ GPIOD
    movs r1, #0x10
    str r1, [r3, #0x00]         @ PD2 output

    ldr r0, =0x48000400         @ GPIOB
    ldr r1, =0x00050400         @ PB5/PB8/PB9 output
    str r1, [r0, #0x00]

    ldr r5, =0x48000000         @ GPIOA
    movs r1, #0
    ldr r1, =0x00010000         @ PA8 output (RD)
    str r1, [r5, #0x00]

    ldr r6, =0x02000000         @ reset PB9: CS low
    str r6, [r0, #0x18]
    movs r6, #0x80
    lsls r6, r6, #1             @ 0x100: set PB8 (RS high)
    str r6, [r0, #0x18]
    movs r6, #0x20              @ set PB5: WR high
    str r6, [r0, #0x18]
    movs r6, #0x80
    lsls r6, r6, #1             @ 0x100: set PA8 (RD high)
    str r6, [r5, #0x18]

    @ Latch 0xA5 through PD2.
    ldr r1, =0xa500
    str r1, [r2, #0x14]
    movs r1, #4
    str r1, [r3, #0x18]         @ PD2 high
    movs r1, #4
    lsls r1, r1, #16
    str r1, [r3, #0x18]         @ PD2 low: latch 0xA5

    @ Command 0x22: write GRAM.
    movs r1, #0x22
    str r1, [r2, #0x14]
    movs r6, #0x80
    lsls r6, r6, #17            @ 0x01000000: reset PB8 (RS low)
    str r6, [r0, #0x18]
    movs r6, #0x80
    lsls r6, r6, #14            @ 0x00200000: reset PB5 (WR low)
    str r6, [r0, #0x18]
    movs r6, #0x20
    str r6, [r0, #0x18]         @ WR high: command

    @ Data phase: RS high, 320*240 words of 0x001F.
    movs r6, #0x80
    lsls r6, r6, #1
    str r6, [r0, #0x18]         @ RS high
    ldr r1, =0x001f
    ldr r7, =76800
    ldr r8, =0x00200000         @ WR low
    movs r9, #0x20              @ WR high
write_pixels:
    str r1, [r2, #0x14]
    str r8, [r0, #0x18]
    str r9, [r0, #0x18]
    subs r7, r7, #1
    bne write_pixels

spin:
    b spin
