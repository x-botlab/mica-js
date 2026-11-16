; Self-made CT107D key-matrix scan: three P3 snapshots under different driven
; patterns, latched into U6/U7/U8 for fused-vs-discrete port comparison.
;   U6: P3 all weak-high (detects independent keys and P42/GND column keys)
;   U7: P3.4 low (detects P34 column keys)
;   U8: P3.5 low (detects P35 column keys)
        ORG 0
LOOP:
        MOV P3,#0xFF
        MOV A,P3
        MOV P0,A
        MOV P2,#0x80
        ACALL DELAY
        MOV P2,#0x00

        MOV P3,#0xEF
        MOV A,P3
        MOV P0,A
        MOV P2,#0xE0
        ACALL DELAY
        MOV P2,#0x00

        MOV P3,#0xDF
        MOV A,P3
        MOV P0,A
        MOV P2,#0xC0
        ACALL DELAY
        MOV P2,#0x00

        SJMP LOOP

DELAY:
        MOV R6,#40
DELAY_OUTER:
        MOV R7,#250
DELAY_INNER:
        DJNZ R7,DELAY_INNER
        DJNZ R6,DELAY_OUTER
        RET
