; Self-made CT107D IR/J2 regression: sample P1 continuously and latch it into U6.
; J2 selects whether P1.1 sees U20 (VS1838) or U11 (CX20106A).
        ORG 0
LOOP:
        MOV P1,#0xFF
        MOV A,P1
        MOV P0,A
        MOV P2,#0x80
        MOV P2,#0x00
        MOV R7,#20
DELAY:
        DJNZ R7,DELAY
        SJMP LOOP
