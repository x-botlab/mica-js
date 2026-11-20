; Self-made resistor/port-mode regression:
;   P3.3 quasi-bidirectional weak pull-up (external S4 can pull it low)
;   P2.0 push-pull strong high (external 1 MΩ weak pull-down on SCL)
;   P3.6 open-drain released with no external load (unknown)
        ORG 0
        MOV P3,#0x48
        MOV P2M1,#0x00
        MOV P2M0,#0x01
        MOV P2,#0x01
        MOV P3M1,#0x40
        MOV P3M0,#0x40
        MOV P3,#0x48
END:
        SJMP END
