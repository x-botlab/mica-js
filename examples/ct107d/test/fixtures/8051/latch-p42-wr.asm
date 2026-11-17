; J13 1-2 memory-mode regression: P42 is the WR strobe for U25, so the latch only
; updates while P42 is low. With J13 2-3 (default IO) this same sequence also works
; because WR is already grounded.
        ORG 0
        MOV P0,#0x5A
        CLR P4.2
        MOV P2,#0x80
        MOV P2,#0x00
        SETB P4.2
END:
        SJMP END
