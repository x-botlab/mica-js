@ systick-irq: SysTick exception every 256 core cycles against a busy thread.
@
@ The workload programs LOAD = 255, VAL = 0 and CTRL = 7 (ENABLE | TICKINT |
@ CLKSOURCE), then spends all remaining time in an integer loop. The SysTick
@ handler increments the tick count at 0x20000000 and returns with bx lr.
@
@ SRAM results:
@   0x20000000  SysTick exception count (incremented by the handler)
@   0x20000004  thread accumulator, mixed with the tick count every iteration
@   0x20000008  last tick count observed by the thread
@
@ Invariants at every instruction boundary outside the handler:
@   ram[0x20000008] <= ram[0x20000000]
@   ram[0x20000008] is monotonically non-decreasing and only changes inside
@   the thread loop; ram[0x20000000] only changes inside the handler.

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
    ldr r3, .Lwork
    ldr r4, .Lmask
    movs r5, #1                @ accumulator
    movs r6, #3                @ step
    .global systick_thread_loop
systick_thread_loop:
.Lthread:
    ldr r7, [r3]               @ tick count
    adds r5, r5, r6
    eors r5, r7
    lsls r5, r5, #1
    ands r5, r4
    str r5, [r3, #4]           @ accumulator snapshot
    ldr r7, [r3]
    str r7, [r3, #8]           @ tick snapshot
    b.n .Lthread
    .align 2
.Lcsr:  .word 0xe000e010
.Lload: .word 0xe000e014
.Lval:  .word 0xe000e018
.Lwork: .word 0x20000000
.Lmask: .word 0x5a5a5a5a
    .size run_workload, . - run_workload

@ SysTick handler: bump the tick counter and return from the exception.
    .global systick_handler
    .type systick_handler, %function
    .thumb_func
systick_handler:
    push {r0, r1}
    ldr r0, .Lisr_count
    ldr r1, [r0]
    adds r1, r1, #1
    str r1, [r0]
    pop {r0, r1}
    bx lr
    .align 2
.Lisr_count: .word 0x20000000
    .size systick_handler, . - systick_handler
