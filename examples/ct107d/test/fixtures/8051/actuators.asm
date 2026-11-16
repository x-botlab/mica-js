; Self-made CT107D actuator regression: latch U9 with Q4/Q6 high so the ULN2003
; channels for K1 (relay) and SP1 (buzzer) sink, then idle.
        ORG 0
        MOV P0,#0xD0
        MOV P2,#0xA0
        MOV P2,#0x00
END:
        SJMP END
