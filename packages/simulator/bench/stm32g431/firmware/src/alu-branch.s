@ alu-branch: 16-bit ALU chain plus conditional branch pairs in a steady loop.
@
@ Per round the fixture runs 24 iterations of
@   b += a;  a = (((a ^ b) << 1) + (b >> 3)) & 0x5a5a5a5a
@ with a push/pop register-save island, then publishes the state and picks one
@ of two branches from `cmp a, b`.
@
@ SRAM results (written on every completed round):
@   0x20000000  a
@   0x20000004  b
@   0x20000008  completed rounds
@   0x2000000c  a & 0x0000ffff          (a != b path)
@   0x2000000c  (b & 0x5a5a5a5a) | a    (a == b path, orrs + ands)
@   0x20000010  same value as 0x0c     (a == b path only)
@   0x20000014  24 * rounds            (shift/add coverage)

    .include "startup.inc"

    .section .text, "ax", %progbits
    .global run_workload
    .type run_workload, %function
    .thumb_func
run_workload:
9:  ldr r0, .Lwork
    ldr r4, .Lmask
    movs r1, #1                @ a
    movs r2, #0                @ b
    movs r3, #0                @ rounds
    movs r5, #24               @ iterations per round
    .global alu_round_loop
alu_round_loop:
.Lround:
    adds r2, r2, r1            @ b += a
    push {r1, r2}
    movs r6, r1
    eors r6, r2
    lsls r6, r6, #1
    lsrs r7, r2, #3
    adds r6, r6, r7
    ands r6, r4
    pop {r1, r2}
    adds r1, r1, r6
    ands r1, r1, r4
    subs r5, r5, #1
    bne.n .Lround
    adds r3, r3, #1
    str r1, [r0]
    str r2, [r0, #4]
    str r3, [r0, #8]
    cmp r1, r2
    beq.n .Lequal
    ldr r6, .Llow16
    ands r6, r6, r1
    str r6, [r0, #12]
    b.n .Lpublish
.Lequal:
    movs r6, r1
    orrs r6, r2
    ands r6, r4
    str r6, [r0, #12]
    str r6, [r0, #16]
    lsls r6, r3, #1
    adds r6, r6, r3
    lsls r6, r6, #3             @ 24 * rounds
    str r6, [r0, #20]
.Lpublish:
    movs r5, #24
    b.n .Lround
    .align 2
.Lwork:  .word 0x20000000
.Lmask:  .word 0x5a5a5a5a
.Llow16: .word 0x0000ffff
    .size run_workload, . - run_workload

@ No periodic interrupt in this fixture; keep the vector slot inert.
    .global systick_handler
    .type systick_handler, %function
    .thumb_func
systick_handler:
.Lpark:
    b.n .Lpark
    .size systick_handler, . - systick_handler
