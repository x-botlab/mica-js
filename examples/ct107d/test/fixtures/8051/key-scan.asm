; Self-made CT107D key-matrix scan with real column drives. Each scan grounds one
; column and reads the four P3 rows; latches are U6=P42, U8=P35, U7=P34, U9=P44.
; The J5 selector decides whether the S4-S7 common column is GND (independent) or
; P44 (4x4 matrix), so U9 is meaningful only with J5 in the 1-2 position.
        ORG 0
LOOP:
        MOV P4,#0xFF
        MOV P3,#0xFF
        CLR P4.2
        MOV A,P3
        MOV P0,A
        MOV P2,#0x80
        ACALL DELAY
        MOV P2,#0x00
        SETB P4.2

        MOV P3,#0xDF
        MOV A,P3
        MOV P0,A
        MOV P2,#0xC0
        ACALL DELAY
        MOV P2,#0x00

        MOV P3,#0xEF
        MOV A,P3
        MOV P0,A
        MOV P2,#0xE0
        ACALL DELAY
        MOV P2,#0x00

        MOV P3,#0xFF
        CLR P4.4
        MOV A,P3
        MOV P0,A
        MOV P2,#0xA0
        ACALL DELAY
        MOV P2,#0x00
        SETB P4.4

        SJMP LOOP

DELAY:
        MOV R6,#40
DELAY_OUTER:
        MOV R7,#250
DELAY_INNER:
        DJNZ R7,DELAY_INNER
        DJNZ R6,DELAY_OUTER
        RET
