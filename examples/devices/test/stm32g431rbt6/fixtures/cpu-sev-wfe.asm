.syntax unified
.thumb
.section .text
.word 0x20005800
.word reset+1
.thumb_func
reset:
    movw r0, #0x0000
    movt r0, #0x4800
    movs r1, #1
    str r1, [r0, #0]         /* PA0 output */
    sev
    wfe                       /* event set: must continue without polling */
    str r1, [r0, #0x14]       /* PA0 high on success */
1:  b 1b
