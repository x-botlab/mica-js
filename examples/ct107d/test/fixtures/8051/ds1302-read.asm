; Self-made CT107D DS1302 regression: wait ~2 s, then read the seconds register
; over P1.3/RST, P1.7/SCLK and P2.3/IO, and latch the BCD value into U6.
        ORG 0
        ACALL WAIT2S
        CLR P1.3
        CLR P1.7
        SETB P1.3
        MOV A,#0x81
        ACALL SEND
        ACALL RECV
        MOV P0,A
        MOV P2,#0x80
        ACALL DELAY
        MOV P2,#0x00
        CLR P1.3
END:
        SJMP END

SEND:
        MOV R2,#8
SEND_LOOP:
        RRC A
        MOV P2.3,C
        SETB P1.7
        CLR P1.7
        DJNZ R2,SEND_LOOP
        RET

RECV:
        MOV R2,#8
        CLR A
RECV_LOOP:
        SETB P1.7
        CLR P1.7
        MOV C,P2.3
        RRC A
        DJNZ R2,RECV_LOOP
        RET

WAIT2S:
        MOV R6,#85
WAIT2S_OUTER:
        MOV R7,#255
WAIT2S_MIDDLE:
        MOV R3,#255
WAIT2S_INNER:
        DJNZ R3,WAIT2S_INNER
        DJNZ R7,WAIT2S_MIDDLE
        DJNZ R6,WAIT2S_OUTER
        RET

DELAY:
        MOV R6,#40
DELAY_OUTER:
        MOV R7,#250
DELAY_INNER:
        DJNZ R7,DELAY_INNER
        DJNZ R6,DELAY_OUTER
        RET
