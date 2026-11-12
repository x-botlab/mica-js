@ ram-copy: word, block and byte copies between flash tables and SRAM.
@
@ Every pass, in order:
@   1. 16 words  flash table -> 0x20000020
@   2. 16 words  0x20000020  -> 0x20000060
@   3. 64 bytes  flash table -> 0x200000a0 (ldrb/strb with a register offset)
@   4. XOR checksum of the 16 words at 0x20000060
@
@ SRAM results:
@   0x20000000  XOR of the 16 words copied to 0x20000060
@   0x20000004  completed passes
@   0x20000008  first word at 0x20000020 (flash table word 0)
@   0x2000000c  last word of the byte copy (bytes 60..63 at 0x200000dc)
@   0x20000020  flash table copy (64 bytes)
@   0x20000060  SRAM-to-SRAM copy (64 bytes)
@   0x200000a0  byte copy (64 bytes)

    .include "startup.inc"

    .section .text, "ax", %progbits
    .global run_workload
    .type run_workload, %function
    .thumb_func
run_workload:
9:  ldr r6, .Lwork
    movs r7, #0                @ completed passes
    .global ram_copy_pass_loop
ram_copy_pass_loop:
.Lpass:
    ldr r0, .Ltable
    ldr r1, .Ldst1
    ldr r2, .Ltable_end
.Lcopy_flash:
    ldr r4, [r0]
    str r4, [r1]
    adds r0, r0, #4
    adds r1, r1, #4
    cmp r0, r2
    bne.n .Lcopy_flash
    ldr r0, .Ldst1
    ldr r1, .Ldst2
    ldr r2, .Ldst2_end
.Lcopy_sram:
    ldr r4, [r0]
    str r4, [r1]
    adds r0, r0, #4
    adds r1, r1, #4
    cmp r0, r2
    bne.n .Lcopy_sram
    ldr r0, .Ltable
    ldr r1, .Ldst3
    movs r3, #0                @ byte index
    movs r2, #64               @ byte count
.Lcopy_bytes:
    ldrb r4, [r0, r3]
    strb r4, [r1, r3]
    adds r3, r3, #1
    cmp r3, r2
    bne.n .Lcopy_bytes
    ldr r0, .Ldst2
    ldr r1, .Ldst2_end
    movs r5, #0                @ checksum
.Lchecksum:
    ldr r4, [r0]
    eors r5, r4
    adds r0, r0, #4
    cmp r0, r1
    bne.n .Lchecksum
    adds r7, r7, #1
    str r5, [r6]
    str r7, [r6, #4]
    ldr r0, .Ldst1
    ldr r4, [r0]
    str r4, [r6, #8]
    ldr r0, .Ldst3
    ldr r4, [r0, #60]
    str r4, [r6, #12]
    b.n .Lpass
    .align 2
.Lwork:      .word 0x20000000
.Ltable:     .word .Lsource
.Ltable_end: .word .Lsource_end
.Ldst1:      .word 0x20000020
.Ldst2:      .word 0x20000060
.Ldst2_end:  .word 0x200000a0
.Ldst3:      .word 0x200000a0
    .size run_workload, . - run_workload

@ 16 words of deterministic source data (word i = 0x10203040 + i * 0x01010101).
    .align 2
.Lsource:
    .word 0x10203040, 0x11213141, 0x12223242, 0x13233343
    .word 0x14243444, 0x15253545, 0x16263646, 0x17273747
    .word 0x18283848, 0x19293949, 0x1a2a3a4a, 0x1b2b3b4b
    .word 0x1c2c3c4c, 0x1d2d3d4d, 0x1e2e3e4e, 0x1f2f3f4f
.Lsource_end:

@ No periodic interrupt in this fixture; keep the vector slot inert.
    .global systick_handler
    .type systick_handler, %function
    .thumb_func
systick_handler:
.Lpark:
    b.n .Lpark
    .size systick_handler, . - systick_handler
