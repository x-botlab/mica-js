@ mixed: the fifth main workload. One loop pass combines a BL helper call
@ (push/pop + eight-word copy + XOR), an ITE block fed by the SysTick tick
@ parity, ALU mixing of the tick count, GPIO ODR/IDR readback and the periodic
@ SysTick handler that counts ticks and toggles PA5 through BSRR.
@
@ The pass executes 30+ distinct thread instructions plus the handler, so a CPU
@ model emits a non-trivial basic-block/translation-unit set instead of a
@ handful-instruction toy loop.
@
@ SRAM results:
@   0x20000000  SysTick exception count (handler only)
@   0x20000004  accumulator = ((tick + ite_delta) << 1) & 0x5a5a5a5a, ite_delta in {0x10, 0x20}
@   0x20000008  tick snapshot taken by the thread
@   0x2000000c  completed thread passes (thread only)
@   0x20000010  helper checksum = XOR of the eight copied words
@   0x20000014  GPIOA ODR sample
@   0x20000018  GPIOA IDR sample
@   0x2000001c  (tick ^ accumulator) & 0x5a5a5a5a
@   0x20000020  8-word flash table copy (0x20000020..0x2000003f)
@
@ Invariants: ram[0x20000008] <= ram[0x20000000]; the handler is the only
@ writer of 0x20000000 and BSRR; the copy at 0x20000020 always equals the flash
@ table after a completed pass; ram[0x20000014] is the PA5 level sampled from
@ ODR, either 0x00000000 or 0x00000020.

    .include "startup.inc"

    .section .text, "ax", %progbits
    .global run_workload
    .type run_workload, %function
    .thumb_func
run_workload:
9:  ldr r0, .Lcsr
    ldr r1, .Lload
    movs r2, #255
    str r2, [r1]               @ SYST_LOAD = 255
    ldr r1, .Lval
    movs r2, #0
    str r2, [r1]               @ SYST_VAL = 0
    movs r2, #7
    str r2, [r0]               @ SYST_CSR = ENABLE | TICKINT | CLKSOURCE
    ldr r5, .Lwork             @ 0x20000000
    ldr r6, .Lmask             @ 0x5a5a5a5a
    movs r7, #0                @ completed passes
    .global mixed_thread_loop
mixed_thread_loop:
.Lthread:
    bl copy_block
    str r0, [r5, #16]          @ helper checksum
    ldr r3, [r5]               @ tick count
    movs r1, #1
    ands r1, r3
    cmp r1, #0
    ite eq
    moveq r2, #0x10
    movne r2, #0x20
    adds r4, r3, r2
    lsls r4, r4, #1
    ands r4, r6
    str r4, [r5, #4]           @ accumulator snapshot
    ldr r3, [r5]
    str r3, [r5, #8]           @ tick snapshot
    ldr r1, .Lodr
    ldr r2, [r1]
    str r2, [r5, #20]          @ ODR sample (PA5 level)
    ldr r1, .Lidr
    ldr r2, [r1]
    str r2, [r5, #24]          @ IDR sample
    eors r4, r3
    ands r4, r6
    str r4, [r5, #28]          @ tick ^ accumulator
    adds r7, r7, #1
    str r7, [r5, #12]          @ pass counter
    b.n .Lthread
    .align 2
.Lcsr:      .word 0xe000e010
.Lload:     .word 0xe000e014
.Lval:      .word 0xe000e018
.Lwork:     .word 0x20000000
.Lmask:     .word 0x5a5a5a5a
.Lodr:      .word 0x48000014
.Lidr:      .word 0x48000010
    .size run_workload, . - run_workload

@ Copy eight flash words to 0x20000020..0x2000003f and return their XOR in r0.
@ Called with BL, saves its working registers with push/pop, returns with bx lr.
    .type copy_block, %function
    .thumb_func
    .global mixed_copy_helper
mixed_copy_helper:
copy_block:
    push {r1, r2, r3, r4}
    ldr r1, .Ltable
    ldr r2, .Ldest
    ldr r3, .Ldest_end
    movs r0, #0
.Lcopy:
    ldr r4, [r1]
    str r4, [r2]
    eors r0, r4
    adds r1, r1, #4
    adds r2, r2, #4
    cmp r2, r3
    bne.n .Lcopy
    pop {r1, r2, r3, r4}
    bx lr
    .align 2
.Ltable:    .word .Lmixed_table
.Ldest:     .word 0x20000020
.Ldest_end: .word 0x20000040
    .size copy_block, . - copy_block

@ SysTick handler: count ticks and toggle PA5 on odd ticks.
    .global systick_handler
    .type systick_handler, %function
    .thumb_func
systick_handler:
    push {r0, r1, r2}
    ldr r0, .Lisr_count
    ldr r1, [r0]
    adds r1, r1, #1
    str r1, [r0]
    movs r2, #1
    ands r2, r1
    ldr r0, .Lisr_bsrr
    beq.n .Lisr_low
    ldr r1, .Lisr_clear
    b.n .Lisr_write
.Lisr_low:
    ldr r1, .Lisr_set
.Lisr_write:
    str r1, [r0]
    pop {r0, r1, r2}
    bx lr
    .align 2
.Lisr_count: .word 0x20000000
.Lisr_bsrr:  .word 0x48000018
.Lisr_clear: .word 0x00200000
.Lisr_set:   .word 0x00000020
    .size systick_handler, . - systick_handler

@ Overlay-free copy of eight deterministic words (word i = 0x11223344 + i * 0x11111111).
    .align 2
.Lmixed_table:
    .word 0x11223344, 0x22334455, 0x33445566, 0x44556677
    .word 0x55667788, 0x66778899, 0x778899aa, 0x8899aabb
