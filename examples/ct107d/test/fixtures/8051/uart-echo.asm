; Self-made CT107D UART echo firmware for the fused-device regression.
; 11.0592 MHz, timer 1 mode 2, 9600 8N1. Echoes every received byte.
        ORG 0
        MOV AUXR,#0x00
        MOV P3,#0xFF
        MOV SCON,#0x50
        MOV TMOD,#0x20
        MOV TH1,#0xFD
        MOV TL1,#0xFD
        SETB TR1
LOOP:
        JNB RI,LOOP
        MOV A,SBUF
        CLR RI
        MOV SBUF,A
WAIT:
        JNB TI,WAIT
        CLR TI
        SJMP LOOP
