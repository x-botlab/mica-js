; Exact two-phase CT107D matrix scan from 模板（矩阵键盘KBD）/main.c:
;   P3=0x0F, P44=0, P42=0; get() -> row half
;   P3=0xF0, P44=1, P42=1; get() -> column half
; get()=(P3&0x3F)|((P4&0x10)<<3)|((P4&0x04)<<4). The resulting key code is
; latched into U6 so the fused and discrete board can observe the real P4 pins.
        ORG 0
LOOP:
        MOV P3,#0x0F
        CLR P4.4
        CLR P4.2
        MOV A,P3
        ANL A,#0x3F
        MOV R2,A
        MOV A,P4
        ANL A,#0x10
        RL A
        RL A
        RL A
        ORL A,R2
        MOV R2,A
        MOV A,P4
        ANL A,#0x04
        RL A
        RL A
        RL A
        RL A
        ORL A,R2
        MOV R3,A

        MOV P3,#0xF0
        SETB P4.4
        SETB P4.2
        MOV A,P3
        ANL A,#0x3F
        MOV R2,A
        MOV A,P4
        ANL A,#0x10
        RL A
        RL A
        RL A
        ORL A,R2
        MOV R2,A
        MOV A,P4
        ANL A,#0x04
        RL A
        RL A
        RL A
        RL A
        ORL A,R2
        ORL A,R3

        MOV P0,A
        MOV P2,#0x80
        MOV P2,#0x00
        ACALL DELAY
        SJMP LOOP

DELAY:
        MOV R6,#4
DELAY_OUTER:
        MOV R7,#250
DELAY_INNER:
        DJNZ R7,DELAY_INNER
        DJNZ R6,DELAY_OUTER
        RET
