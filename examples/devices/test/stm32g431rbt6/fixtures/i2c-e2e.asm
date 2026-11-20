@ STM32G431RBT6 I2C1 主机端到端夹具。
@
@ 初始化 PB8/PB7 为 AF4 开漏，I2C1 100 kHz（16 MHz 内核时钟），然后在同一总线上：
@ 1) 向 AT24C02 (0x50) 地址 0 写 0x5A；
@ 2) 用“写地址 + 重复 START + 读”随机读回并校验；
@ 3) 向 MCP4017 (0x2F) 写 wiper 0x60；
@ 4) 读回 wiper 并校验。
@ 成功拉高 PA5，任一 NACK/校验失败拉高 PA6。

    .syntax unified
    .cpu cortex-m4
    .thumb

    .section .vectors, "a", %progbits
    .word 0x20005800
    .word reset + 1

    .section .text
    .thumb_func
reset:
    ldr r0, =0x40021000
    movs r1, #3
    str r1, [r0, #0x4c]          @ AHB2ENR: GPIOA/GPIOB
    movs r1, #1
    lsls r1, r1, #21
    str r1, [r0, #0x58]          @ APB1ENR1: I2C1EN

    ldr r0, =0x48000400          @ GPIOB
    ldr r1, =0x00028000
    str r1, [r0, #0x00]          @ MODER: PB7/PB8 = AF
    movs r1, #0x180
    str r1, [r0, #0x04]          @ OTYPER: open-drain
    movs r1, #0
    str r1, [r0, #0x0C]          @ PUPDR: no internal pull
    ldr r1, =0x40000000
    str r1, [r0, #0x20]          @ AFR0: PB7 = AF4
    movs r1, #4
    str r1, [r0, #0x24]          @ AFR1: PB8 = AF4

    ldr r0, =0x48000000          @ GPIOA
    ldr r1, =0x00001400
    str r1, [r0, #0x00]          @ PA5/PA6 push-pull output

    ldr r4, =0x40005400          @ I2C1
    ldr r1, =0x00304F4F          @ 100 kHz @ 16 MHz (PRESC=0,SCLH=0x4F,SCLL=0x4F)
    str r1, [r4, #0x10]          @ TIMINGR
    movs r1, #1
    str r1, [r4, #0x00]          @ CR1.PE

    @ AT24C02 byte write: address byte 0x00, data 0x5A
    ldr r1, =0x020220A0          @ SADD=0x50,W NBYTES=2 START AUTOEND
    str r1, [r4, #0x04]
    bl wait_txis
    movs r1, #0x00
    str r1, [r4, #0x28]
    bl wait_txis
    movs r1, #0x5A
    str r1, [r4, #0x28]
    bl wait_stopf
    bl clear_stopf

    @ AT24C02 random read: dummy write address 0, repeated START, read 1 byte
    ldr r1, =0x000120A0          @ SADD=0x50,W NBYTES=1 START, no AUTOEND
    str r1, [r4, #0x04]
    bl wait_txis
    movs r1, #0x00
    str r1, [r4, #0x28]
    bl wait_tc
    ldr r1, =0x020124A0          @ SADD=0x50,R NBYTES=1 START AUTOEND
    str r1, [r4, #0x04]
    bl wait_rxne
    ldr r1, [r4, #0x24]
    cmp r1, #0x5A
    bne fail
    bl wait_stopf
    bl clear_stopf

    @ MCP4017 write wiper 0x60
    ldr r1, =0x0201205E          @ SADD=0x2F,W NBYTES=1 START AUTOEND
    str r1, [r4, #0x04]
    bl wait_txis
    movs r1, #0x60
    str r1, [r4, #0x28]
    bl wait_stopf
    bl clear_stopf

    @ MCP4017 read wiper
    ldr r1, =0x0201245E          @ SADD=0x2F,R NBYTES=1 START AUTOEND
    str r1, [r4, #0x04]
    bl wait_rxne
    ldr r1, [r4, #0x24]
    cmp r1, #0x60
    bne fail
    bl wait_stopf
    bl clear_stopf

    ldr r0, =0x48000000
    movs r1, #0x20              @ PA5 high = success
    str r1, [r0, #0x14]
done:
    b done

fail:
    ldr r0, =0x48000000
    movs r1, #0x40              @ PA6 high = failure
    str r1, [r0, #0x14]
    b fail

wait_txis:
    ldr r1, [r4, #0x18]         @ 动态偏移读取 ISR
    tst r1, #0x10               @ NACKF
    bne fail
    tst r1, #0x02               @ TXIS
    beq wait_txis
    bx lr

wait_rxne:
    ldr r1, [r4, #0x18]
    tst r1, #0x10
    bne fail
    tst r1, #0x04               @ RXNE
    beq wait_rxne
    bx lr

wait_tc:
    ldr r1, [r4, #0x18]
    tst r1, #0x10
    bne fail
    tst r1, #0x40               @ TC
    beq wait_tc
    bx lr

wait_stopf:
    ldr r1, [r4, #0x18]
    tst r1, #0x10
    bne fail
    tst r1, #0x20               @ STOPF
    beq wait_stopf
    bx lr

clear_stopf:
    movs r1, #0x20
    str r1, [r4, #0x1C]         @ ICR.STOPCF
    bx lr
