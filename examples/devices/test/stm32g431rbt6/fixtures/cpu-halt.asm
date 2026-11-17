.syntax unified
.thumb
.section .text
.word 0x20005800
.word reset+1
.thumb_func
reset:
    .short 0xb700
    .short 0xffff
    .short 0xffff
    .short 0xffff
