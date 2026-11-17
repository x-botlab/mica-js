.syntax unified
.thumb
.arch armv7e-m
.fpu fpv4-sp-d16
.section .isr_vector,"a"
.word 0x20010000
.word reset+1
.section .text
.global reset
reset:
ldr r0,=0xe000ed88
ldr r1,=0x00f00000
str r1,[r0]
dsb
isb
bl main
b .
.ltorg
