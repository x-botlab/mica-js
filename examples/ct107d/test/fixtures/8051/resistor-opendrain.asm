; Self-made open-drain regression: P2.0 releases into an external 1 MΩ weak
; pull-down on the I²C SCL net. The resolved net must be low, not unknown.
        ORG 0
        MOV P2M1,#0x01
        MOV P2M0,#0x01
        MOV P2,#0x01
END:
        SJMP END
