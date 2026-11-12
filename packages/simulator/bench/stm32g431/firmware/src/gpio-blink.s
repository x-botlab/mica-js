@ gpio-blink: PA5 (bit 5) driven through GPIOA BSRR with a busy-wait delay.
@
@ Reset already enabled the GPIOA clock and set MODER bits 11:10 = 01 (PA5
@ push-pull output). The loop sets PA5 through BSRR, samples ODR, waits,
@ clears PA5 through BSRR, samples ODR and IDR, waits, and counts toggles.
@
@ SRAM results (written every loop):
@   0x20000000  set mask used for BSRR (0x00000020)
@   0x20000004  ODR while PA5 is set (0x00000020)
@   0x20000008  ODR while PA5 is cleared (0x00000000)
@   0x2000000c  IDR snapshot (model dependent: external level on PA5)
@   0x20000010  number of pin transitions (increments by 2 per loop)

    .include "startup.inc"

    .section .text, "ax", %progbits
    .global run_workload
    .type run_workload, %function
    .thumb_func
run_workload:
9:  ldr r0, .Lbsrr
    ldr r1, .Lset
    ldr r2, .Lreset
    ldr r3, .Lodr
    ldr r4, .Lwork
    ldr r7, .Lidr
    .global gpio_toggle_loop
gpio_toggle_loop:
.Ltoggle:
    str r1, [r0]               @ BSRR: drive PA5 high
    ldr r6, [r3]
    str r6, [r4, #4]           @ ODR readback while set
    movs r5, #24
.Ldelay_high:
    subs r5, r5, #1
    bne.n .Ldelay_high
    str r2, [r0]               @ BSRR: drive PA5 low
    ldr r6, [r3]
    str r6, [r4, #8]           @ ODR readback while cleared
    ldr r6, [r7]
    str r6, [r4, #12]          @ IDR sample
    ldr r6, [r4, #16]
    adds r6, r6, #2
    str r6, [r4, #16]
    str r1, [r4]               @ publish the PA5 set mask
    movs r5, #24
.Ldelay_low:
    subs r5, r5, #1
    bne.n .Ldelay_low
    b.n .Ltoggle
    .align 2
.Lbsrr:  .word 0x48000018
.Lodr:   .word 0x48000014
.Lidr:   .word 0x48000010
.Lset:   .word 0x00000020
.Lreset: .word 0x00200000
.Lwork:  .word 0x20000000
    .size run_workload, . - run_workload

@ No periodic interrupt in this fixture; keep the vector slot inert.
    .global systick_handler
    .type systick_handler, %function
    .thumb_func
systick_handler:
.Lpark:
    b.n .Lpark
    .size systick_handler, . - systick_handler
