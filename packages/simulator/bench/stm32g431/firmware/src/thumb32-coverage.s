@ thumb32-coverage: deliberate Thumb-2 / system-instruction coverage.
@
@ This is a correctness fixture, not a benchmark: it exercises MOVW, MOVT,
@ BL, an IT block and CPSID/CPSIE inside a steady loop so a CPU model can be
@ checked independent of the 16-bit benchmark workloads.
@
@ SRAM results (rewritten every pass):
@   0x20000000  sum of the eight table words (returned by BL subroutine)
@   0x20000004  IT-block result (r3): 1 + 2 = 3 while r1 != r2
@   0x20000008  MOVW/MOVT constant 0xa5a500a5 (moved to the LR/return via r1)
@   0x2000000c  completed passes
@   0x20000010  BSRR-free ODR mirror written with a 16-bit str

    .include "startup.inc"

    .section .text, "ax", %progbits
    .global run_workload
    .type run_workload, %function
    .thumb_func
run_workload:
9:  movw r1, #0x00a5
    movt r1, #0xa5a5
    ldr r4, .Lwork
    str r1, [r4, #8]
    movs r5, #0                @ completed passes
    .global thumb32_coverage_loop
thumb32_coverage_loop:
.Lloop:
    bl sum_table
    movs r1, #1
    movs r2, #2
    cmp r1, r2
    itt ne
    movne r3, r1
    addne r3, r3, r2
    cpsid i
    str r0, [r4]
    str r3, [r4, #4]
    cpsie i
    adds r5, r5, #1
    str r5, [r4, #12]
    b.n .Lloop
    .align 2
.Lwork:     .word 0x20000000
    .size run_workload, . - run_workload

@ Sum eight words; returns in r0. Called with BL, returns with bx lr.
@ The literal pool sits after bx lr so both loads stay 16-bit forward loads.
    .type sum_table, %function
    .thumb_func
sum_table:
    push {r1, r2, r3}
    ldr r1, .Lsum_table
    ldr r2, .Lsum_table_end
    movs r0, #0
.Lsum:
    ldr r3, [r1]
    adds r0, r0, r3
    adds r1, r1, #4
    cmp r1, r2
    bne.n .Lsum
    pop {r1, r2, r3}
    bx lr
    .align 2
.Lsum_table:     .word .Lcoverage_table
.Lsum_table_end: .word .Lcoverage_table_end
    .size sum_table, . - sum_table

    .align 2
.Lcoverage_table:
    .word 0x00000001, 0x00000002, 0x00000004, 0x00000008
    .word 0x00000010, 0x00000020, 0x00000040, 0x00000080
.Lcoverage_table_end:

@ No periodic interrupt in this fixture; keep the vector slot inert.
    .global systick_handler
    .type systick_handler, %function
    .thumb_func
systick_handler:
.Lpark:
    b.n .Lpark
    .size systick_handler, . - systick_handler
