; Self-made CT107D latch regression: capture 0xA5 into U6 at startup.
        ORG 0
        MOV P0,#0xA5
        MOV P2,#0x80
        MOV P2,#0x00
END:
        SJMP END
