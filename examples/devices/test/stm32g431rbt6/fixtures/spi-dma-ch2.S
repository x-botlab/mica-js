@ STM32G431RBT6 SPI1 双通道 DMA：CH1 TX、CH2 RX。
@
@ PA5/PA6/PA7 AF5，PA7–PA6 板级短接。CH1 只负责 TX，CH2 只负责 RX；
@ 固件等到 CH2 TC 后再结束，因此不会在 RX 完成前关闭 RXDMAEN。
@ SRAM 0x20000000=2 表示 CH2 TC 已到，0x20000008 保存 CH2 剩余 CNDTR，
@ 0x20000020 起是 4 字节回环结果。
    .syntax unified
    .cpu cortex-m4
    .thumb

    .section .isr_vector, "a", %progbits
    .word 0x20005800
    .word reset + 1
    .rept 119
    .word default_handler + 1
    .endr

    .section .text
    .thumb_func
default_handler:
    b default_handler

    .global reset
    .thumb_func
reset:
    ldr r0, =0x40021000
    movs r1, #1
    str r1, [r0, #0x4c]          @ AHB2ENR: GPIOA
    movs r1, #1
    lsls r1, r1, #12
    str r1, [r0, #0x60]          @ APB2ENR: SPI1EN
    movs r1, #5
    str r1, [r0, #0x48]          @ AHB1ENR: DMA1EN | DMAMUX1EN

    ldr r0, =0x48000000
    ldr r1, =0x0000A800
    str r1, [r0, #0x00]          @ PA5/6/7 AF
    movs r1, #0
    str r1, [r0, #0x04]
    str r1, [r0, #0x0C]
    ldr r1, =0x55500000
    str r1, [r0, #0x20]          @ AF5

    ldr r4, =0x20000010
    ldr r1, =0xC33CA55A
    str r1, [r4, #0]             @ source 0x5A,0xA5,0x3C,0xC3

    ldr r0, =0x40013000          @ SPI1
    ldr r1, =0x0000007C          @ SPE|MSTR|BR=111
    str r1, [r0, #0x00]
    ldr r1, =0x00000703          @ DS=7 + TXDMAEN + RXDMAEN
    str r1, [r0, #0x04]

    ldr r5, =0x40020800          @ DMAMUX
    movs r1, #0x0B
    str r1, [r5, #0]             @ CH1 SPI1_TX
    movs r1, #0x0A
    str r1, [r5, #4]             @ CH2 SPI1_RX

    ldr r6, =0x40020000          @ DMA1
    movs r1, #4
    str r1, [r6, #0x0C]          @ CH1 CNDTR
    ldr r1, =0x4001300C
    str r1, [r6, #0x10]          @ CH1 CPAR = SPI1_DR
    ldr r1, =0x20000010
    str r1, [r6, #0x14]          @ CH1 CMAR = source
    movs r1, #0x91               @ EN|DIR|MINC (mem->periph)
    str r1, [r6, #0x08]          @ CH1 CCR

    movs r1, #4
    str r1, [r6, #0x20]          @ CH2 CNDTR (0x1c + 0x04)
    ldr r1, =0x4001300C
    str r1, [r6, #0x24]          @ CH2 CPAR (0x1c + 0x08)
    ldr r1, =0x20000020
    str r1, [r6, #0x28]          @ CH2 CMAR (0x1c + 0x0c)
    movs r1, #0x81               @ EN|MINC (periph->mem)
    str r1, [r6, #0x1C]          @ CH2 CCR

wait_ch2:
    ldr r1, [r6]                 @ DMA1 ISR
    tst r1, #0x20                @ TCIF2
    beq wait_ch2
    ldr r1, [r6, #0x20]          @ CH2 CNDTR
    ldr r0, =0x20000008
    str r1, [r0]
    ldr r1, [r6]                 @ ISR snapshot
    ldr r0, =0x2000000C
    str r1, [r0]
    ldr r0, =0x20000000
    movs r1, #2
    str r1, [r0]
1:
    b 1b
