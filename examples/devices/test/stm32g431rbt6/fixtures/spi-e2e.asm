@ STM32G431RBT6 SPI1 主机真实固件回环夹具。
@
@ PA5=SCK、PA7=MOSI、PA6=MISO；板级把 PA7 与 PA6 短接。固件配置 AF5 后：
@ 1) 8 位帧发送 0x5A 并校验回读；
@ 2) 16 位帧发送 0xA55A 并校验回读。
@ 结果写到 SRAM 0x20000000：2=两帧通过，0xEE=失败。

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
    movs r1, #1
    str r1, [r0, #0x4c]          @ AHB2ENR: GPIOA
    movs r1, #1
    lsls r1, r1, #12
    str r1, [r0, #0x60]          @ APB2ENR: SPI1EN

    ldr r0, =0x48000000          @ GPIOA
    ldr r1, =0x0000A800
    str r1, [r0, #0x00]          @ MODER: PA5/PA6/PA7 = AF
    movs r1, #0
    str r1, [r0, #0x04]          @ OTYPER: push-pull
    str r1, [r0, #0x0C]          @ PUPDR: none
    ldr r1, =0x55500000
    str r1, [r0, #0x20]          @ AFR0: PA5/6/7 = AF5

    ldr r4, =0x40013000          @ SPI1
    ldr r1, =0x0000007C          @ SPE|MSTR|BR=111
    str r1, [r4, #0x00]
    movs r1, #0x07
    lsls r1, r1, #8
    str r1, [r4, #0x04]          @ CR2: DS=7 (8-bit)

    movs r1, #0x5A
    strh r1, [r4, #0x0C]
    bl wait_rxne
    ldrh r1, [r4, #0x0C]
    cmp r1, #0x5A
    bne fail

    ldr r1, =0x00000F00
    str r1, [r4, #0x04]          @ CR2: DS=15 (16-bit)
    ldr r1, =0x0000A55A
    strh r1, [r4, #0x0C]
    bl wait_rxne
    ldrh r1, [r4, #0x0C]
    ldr r2, =0x0000A55A
    cmp r1, r2
    bne fail

    ldr r0, =0x20000000
    movs r1, #2
    str r1, [r0]
    b done

fail:
    ldr r0, =0x20000000
    movs r1, #0xEE
    str r1, [r0]
done:
    b done

wait_rxne:
    ldr r1, [r4, #0x08]
    tst r1, #1
    beq wait_rxne
    bx lr
