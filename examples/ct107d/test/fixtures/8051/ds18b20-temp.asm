; Self-made CT107D 1-Wire regression: DS18B20 Convert T on P1.4, wait 750 ms,
; then read the scratchpad temperature LSB/MSB into U6/U7 latches.
        ORG 0
        SETB P1.4
        ACALL RESET
        MOV A,#0xCC
        ACALL WRITE
        MOV A,#0x44
        ACALL WRITE
        ACALL WAIT750
        ACALL RESET
        MOV A,#0xCC
        ACALL WRITE
        MOV A,#0xBE
        ACALL WRITE
        ACALL READ
        MOV R5,A
        ACALL READ
        MOV R4,A

        MOV P0,R5
        MOV P2,#0x80
        ACALL DELAY
        MOV P2,#0x00
        MOV P0,R4
        MOV P2,#0xE0
        ACALL DELAY
        MOV P2,#0x00

END:
        SJMP END

RESET:
        CLR P1.4
        ACALL DLY500
        SETB P1.4
        ACALL DLY500
        RET

WRITE:
        MOV R2,#8
WRITE_LOOP:
        RRC A
        CLR P1.4
        ACALL DLY2
        JNC WRITE_ZERO
        SETB P1.4
        ACALL DLY60
        SJMP WRITE_NEXT
WRITE_ZERO:
        ACALL DLY60
WRITE_NEXT:
        SETB P1.4
        ACALL DLY2
        DJNZ R2,WRITE_LOOP
        RET

READ:
        MOV R2,#8
        CLR A
READ_LOOP:
        CLR P1.4
        ACALL DLY2
        SETB P1.4
        ACALL DLY_SAMPLE
        MOV C,P1.4
        RRC A
        ACALL DLY_SLOT
        DJNZ R2,READ_LOOP
        RET

DLY2:
        MOV R7,#6
DLY2_LOOP:
        DJNZ R7,DLY2_LOOP
        RET

; DS18B20 read sample delay. STC15 is 1T, so count cycles, not 12T machine cycles.
; From the host falling edge to MOV C,P1.4:
;   CLR is assumed complete before t=0; then ACALL+DLY2+SETB = 36 cycles,
;   and ACALL+MOV+DJNZ*N+RET+MOV C = 11 + 4*N cycles after release.
; With N=24: 143 cycles = 12.93 us @11.0592 MHz, 11.92 us @12 MHz.
; Both are inside the model's +15 us read-zero window with margin. The old N=60
; took 287 cycles = 25.95 us / 23.92 us and sampled after the +15 us release.
DLY_SAMPLE:
        MOV R7,#24
DLY_SAMPLE_LOOP:
        DJNZ R7,DLY_SAMPLE_LOOP
        RET

DLY_SLOT:
        MOV R7,#180
DLY_SLOT_LOOP:
        DJNZ R7,DLY_SLOT_LOOP
        RET

DLY60:
        MOV R7,#250
DLY60_LOOP:
        DJNZ R7,DLY60_LOOP
        RET

DLY500:
        MOV R6,#10
DLY500_OUTER:
        MOV R7,#250
DLY500_INNER:
        DJNZ R7,DLY500_INNER
        DJNZ R6,DLY500_OUTER
        RET

WAIT750:
        MOV R6,#64
WAIT750_OUTER:
        MOV R7,#255
WAIT750_MIDDLE:
        MOV R3,#255
WAIT750_INNER:
        DJNZ R3,WAIT750_INNER
        DJNZ R7,WAIT750_MIDDLE
        DJNZ R6,WAIT750_OUTER
        RET

DELAY:
        MOV R6,#40
DELAY_OUTER:
        MOV R7,#250
DELAY_INNER:
        DJNZ R7,DELAY_INNER
        DJNZ R6,DELAY_OUTER
        RET
