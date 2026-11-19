; Self-made CT107D ultrasonic regression: send eight P1.0 pulses, wait for the
; U22 echo on P1.1 to go low, then latch 0xA5 into U6.
        ORG 0
        ; Reset P1.0 is weak-high. Drive it low first so the first SETB is a real
        ; rising edge; otherwise only seven of the eight ultrasonic pulses count.
        CLR P1.0
        MOV R2,#8
PULSE:
        SETB P1.0
        ACALL DLY10
        CLR P1.0
        ACALL DLY10
        DJNZ R2,PULSE
WAIT:
        JB P1.1,WAIT
        MOV P0,#0xA5
        MOV P2,#0x80
        ACALL DELAY
        MOV P2,#0x00
END:
        SJMP END

DLY10:
        MOV R7,#40
DLY10_LOOP:
        DJNZ R7,DLY10_LOOP
        RET

DELAY:
        MOV R6,#40
DELAY_OUTER:
        MOV R7,#250
DELAY_INNER:
        DJNZ R7,DELAY_INNER
        DJNZ R6,DELAY_OUTER
        RET
