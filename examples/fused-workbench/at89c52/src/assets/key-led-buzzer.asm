; 12 MHz / 12T. S1 grounds P3.2; P1.0 and P1.1 sink the LED and active buzzer.
        ORG 0000H
        MOV P1, #0FFH
        MOV P3, #0FFH
loop:   MOV C, P3.2
        MOV P1.0, C
        MOV P1.1, C
        SJMP loop
        END
