@ 标准主 MCU 固件：Thread 使用 PSP，SVC 进入异常后用 MSP 运行并返回 PSP。
@ 结果：0x100=返回后 PSP，0x104=0x99（SVC 后继续执行），0x110=EXC_RETURN，
@ 0x114=handler MSP。0x120/0x124 为 handler/返回后 CPU 观察值。
.syntax unified
.thumb

.section .isr_vector,"a",%progbits
.word 0x20005800
.word reset + 1
.rept 9
.word default_handler + 1
.endr
.word svc_handler + 1       @ exception 11
.rept 108
.word default_handler + 1
.endr

.section .text
.thumb_func
default_handler:
    b default_handler

.thumb_func
reset:
    ldr r0, =0x20005000
    msr psp, r0
    movs r0, #2
    msr control, r0         @ thread uses PSP

    ldr r0, =0x20000100
    svc #0

    @ SVC 返回后仍为 thread/PSP。
    movs r1, #0x99
    str r1, [r0, #4]
    mrs r1, psp
    str r1, [r0, #0]
    mrs r1, msp
    str r1, [r0, #0x24]
1:  b 1b

.thumb_func
svc_handler:
    push {lr}
    pop {r2}
    ldr r0, =0x20000100
    str r2, [r0, #0x10]     @ EXC_RETURN (expect 0xfffffffd)
    mrs r2, msp
    str r2, [r0, #0x14]     @ handler MSP
    mrs r2, ipsr
    str r2, [r0, #0x18]     @ IPSR (expect 11)
    bx lr

.ltorg
