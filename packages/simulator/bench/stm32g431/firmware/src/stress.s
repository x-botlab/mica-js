@ stress: sixth benchmark workload, a large unrolled loop aimed at the IR and
@ generated-function sizes of issue #253. The body is produced by a GAS macro
@ repeated with .rept, so every one of the ~280 instruction words is a real
@ 16-bit Thumb encoding at its own PC.
@
@ One pass mixes ALU work (adds/subs/ands/orrs/eors/lsls/lsrs, immediate and
@ register shifts incl. asrs), RAM word, halfword and byte traffic in the
@ 0x20000000 window, GPIOA ODR/IDR reads plus BSRR writes, literal-pool loads,
@ cmp/bne/beq/bhi conditional branches and a push/pop island. A SysTick handler
@ increments a tick counter and toggles PA5 on odd ticks.
@
@ SRAM results:
@   0x20000000  SysTick exception count (handler only)
@   0x20000004  completed passes (thread only)
@   0x20000008  accumulator after the pass
@   0x2000000c  rolling RAM scratch word updated inside every block
@   0x20000010..0x2000001f  byte lane read with ldrb and written back with strb
@   0x20000020  signature = accumulator ^ tick count at the end of the pass
@   0x20000024  accumulator published on the beq path
@   0x20000028  tick count published on the bhi fallthrough (even tick)
@   0x2000002c  constant 1 published on the bhi taken path (odd tick)
@   0x20000014..0x2000001a  halfword lane written with strh from the scratch word
@
@ Invariants: ram[0x20000020] = ram[0x20000008] ^ ram[0x20000000];
@ ram[0x20000008] is masked with 0x5a5a5a5a; BSRR is written 6 times per pass by
@ the thread plus once per SysTick tick by the handler; bhi is both taken and
@ not taken across passes because the tick parity alternates.

    .include "startup.inc"

    .syntax unified
    .thumb

@ One 14-instruction block; GPIO, byte lanes, halfword lanes and register
@ shifts are spliced in every 3rd/6th/5th/4th block so the pass is not a
@ repetition of a single instruction shape.
    .macro STRESS_BLOCK n
    adds r1, r1, r2
    movs r7, #((\n * 37 + 11) & 0x7f)
    eors r1, r7
    ands r1, r6
    lsls r1, r1, #((\n % 7) + 1)
    lsrs r2, r1, #((\n % 5) + 1)
    orrs r2, r7
    ldr r7, [r0, #12]
    adds r7, r7, r2
    str r7, [r0, #12]
    cmp r2, r1
    bne.n 1f
    adds r1, r1, #1
1:  subs r2, r2, #((\n % 9) + 1)
    .if (\n % 3) == 0
    ldr r7, [r3]
    eors r1, r7
    ldr r7, [r4]
    adds r1, r1, r7
    .if (\n % 2) == 0
    ldr r7, .Lset
    .else
    ldr r7, .Lclear
    .endif
    str r7, [r5]
    .endif
    .if (\n % 6) == 0
    ldrb r7, [r0, #(16 + (\n % 8))]
    strb r7, [r0, #(24 + (\n % 8))]
    .endif
    .if (\n % 5) == 0
    ldrh r7, [r0, #(12 + ((\n % 4) * 2))]
    strh r7, [r0, #(20 + ((\n % 4) * 2))]
    .endif
    .if (\n % 4) == 0
    lsls r2, r1
    lsrs r1, r2
    asrs r2, r1
    .endif
    .endm

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
    ldr r0, .Lwork             @ 0x20000000
    ldr r3, .Lodr
    ldr r4, .Lidr
    ldr r5, .Lbsrr
    ldr r6, .Lmask
    movs r1, #1                @ accumulator
    movs r2, #0                @ mixing operand
    .global stress_loop
stress_loop:
.Lloop:
    push {r6, r7}
    .set blockIndex, 0
    .rept 16
    STRESS_BLOCK blockIndex
    .set blockIndex, blockIndex + 1
    .endr
    pop {r6, r7}
    ldr r7, [r0]               @ tick count
    eors r1, r7
    str r1, [r0, #8]           @ accumulator
    ldr r7, [r0]
    eors r7, r1
    str r7, [r0, #32]          @ signature = accumulator ^ tick
    ldr r7, [r0]               @ tick parity drives a bhi / fallthrough pair
    movs r2, #1
    ands r2, r7
    cmp r2, #0
    bhi.n .Lodd
    str r7, [r0, #40]          @ lo path (even tick)
    b.n .Ljoin
.Lodd:
    str r2, [r0, #44]          @ hi path (odd tick)
.Ljoin:
    cmp r1, r7
    beq.n .Lequal
    ldr r7, [r0, #4]
    adds r7, r7, #1
    str r7, [r0, #4]           @ pass counter
    b.n .Lloop
.Lequal:
    str r1, [r0, #36]          @ accumulator, only on the beq path
    ldr r7, [r0, #4]
    adds r7, r7, #1
    str r7, [r0, #4]
    b.n .Lloop
    .align 2
.Lcsr:   .word 0xe000e010
.Lload:  .word 0xe000e014
.Lval:   .word 0xe000e018
.Lwork:  .word 0x20000000
.Lodr:   .word 0x48000014
.Lidr:   .word 0x48000010
.Lbsrr:  .word 0x48000018
.Lmask:  .word 0x5a5a5a5a
.Lset:   .word 0x00000020
.Lclear: .word 0x00200000
    .size run_workload, . - run_workload

@ SysTick handler: count ticks and toggle PA5 on odd ticks.
    .global systick_handler
    .type systick_handler, %function
    .thumb_func
systick_handler:
    push {r0, r1, r2, r3}
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
    pop {r0, r1, r2, r3}
    bx lr
    .align 2
.Lisr_count: .word 0x20000000
.Lisr_bsrr:  .word 0x48000018
.Lisr_clear: .word 0x00200000
.Lisr_set:   .word 0x00000020
    .size systick_handler, . - systick_handler
