; Self-made CT107D I2C regression: AT24C02 write 0x5A to 0x10, read it back,
; then read PCF8591 AIN2. Results are latched into U6 and U7 for port-level checks.
; P2.0 = SCL, P2.1 = SDA. The models are edge-driven; no physical bus delay is needed.
        ORG 0
        MOV P2,#0xFF

        ACALL START
        MOV A,#0xA0
        ACALL SEND
        MOV A,#0x10
        ACALL SEND
        MOV A,#0x5A
        ACALL SEND
        ACALL STOP

        ACALL START
        MOV A,#0xA0
        ACALL SEND
        MOV A,#0x10
        ACALL SEND
        ACALL START
        MOV A,#0xA1
        ACALL SEND
        ACALL RECV
        MOV P0,A
        MOV P2,#0x80
        ACALL DELAY
        MOV P2,#0x00

        ACALL START
        MOV A,#0x90
        ACALL SEND
        MOV A,#0x02
        ACALL SEND
        ACALL START
        MOV A,#0x91
        ACALL SEND
        ACALL RECV
        MOV P0,A
        MOV P2,#0xE0
        ACALL DELAY
        MOV P2,#0x00

END:
        SJMP END

START:
        SETB P2.1
        SETB P2.0
        CLR P2.1
        CLR P2.0
        RET

STOP:
        CLR P2.1
        SETB P2.0
        SETB P2.1
        RET

SEND:
        MOV R2,#8
SEND_LOOP:
        RLC A
        MOV P2.1,C
        SETB P2.0
        CLR P2.0
        DJNZ R2,SEND_LOOP
        SETB P2.0
        CLR P2.0
        RET

RECV:
        MOV R2,#8
        CLR A
RECV_LOOP:
        SETB P2.0
        MOV C,P2.1
        RLC A
        CLR P2.0
        DJNZ R2,RECV_LOOP
        SETB P2.1
        SETB P2.0
        CLR P2.0
        RET

DELAY:
        MOV R6,#40
DELAY_OUTER:
        MOV R7,#250
DELAY_INNER:
        DJNZ R7,DELAY_INNER
        DJNZ R6,DELAY_OUTER
        RET
