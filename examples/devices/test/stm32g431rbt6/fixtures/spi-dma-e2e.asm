@ STM32G431RBT6 SPI1 双通道 DMA 回环固件。
@
@ PA5/PA6/PA7 AF5，PA7–PA6 板级短接。DMA1 CH1=SPI1_TX、CH2=SPI1_RX，
@ DMAMUX 使用 0x0b/0x0a；CH1 TC 中断（DMA1_Channel1_IRQn=11）写 SRAM 结果。
@ CH1 TC 只表示 TX 写完；继续等待 CH2 TC（RX 4 字节全部完成），之后才关闭
@ CR2.TXDMAEN/RXDMAEN。负向阶段独立：再用 CH3 发一个不会被请求的 TX 传输，
@ 验证 CNDTR 仍为 1。最终 SRAM 0x20000000：2=正/负均通过，3=DMAR 关闭失败。

    .syntax unified
    .cpu cortex-m4
    .thumb

    .section .vectors, "a", %progbits
    .word 0x20005800
    .word reset + 1
    .space (27 - 2) * 4, 0
    .word dma1_ch1_handler + 1

    .section .text
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
    ldr r1, =0x00000093          @ EN|TCIE|MINC|DIR (mem->periph)
    str r1, [r6, #0x08]          @ CH1 CCR

    movs r1, #4
    str r1, [r6, #0x20]          @ CH2 CNDTR
    ldr r1, =0x4001300C
    str r1, [r6, #0x24]          @ CH2 CPAR
    ldr r1, =0x20000020
    str r1, [r6, #0x28]          @ CH2 CMAR = destination
    ldr r1, =0x00000083          @ EN|TCIE|MINC (periph->mem)
    str r1, [r6, #0x1C]          @ CH2 CCR

    ldr r0, =0xE000E100
    movs r1, #0x80
    lsls r1, r1, #4              @ bit11
    str r1, [r0]                 @ NVIC ISER0

wait_tx_tc:
    ldr r0, =0x20000000
    ldr r1, [r0]
    cmp r1, #1
    bne wait_tx_tc

wait_rx_tc:
    ldr r0, =0x40020000
    ldr r1, [r0]                 @ DMA1 ISR
    tst r1, #0x20                @ CH2 TCIF
    beq wait_rx_tc

    ldr r0, =0x40013008
    ldr r1, [r0]
    ldr r0, =0x20000004
    str r1, [r0]                 @ SPI SR after RX completion
    ldr r0, =0x40020020
    ldr r1, [r0]
    ldr r0, =0x20000008
    str r1, [r0]                 @ CH2 CNDTR after TC
    ldr r0, =0x40020000
    ldr r1, [r0]
    ldr r0, =0x2000000C
    str r1, [r0]                 @ DMA1 ISR snapshot after RX TC

    @ 正向 DMA 事务已完成（CH2 TC），现在才关闭 SPI DMA 请求。
    @ 负向阶段独立：CH3 发一个不会被请求的 TX 传输。
    ldr r0, =0x40013000
    ldr r1, =0x00000700
    str r1, [r0, #0x04]          @ CR2: TXDMAEN/RXDMAEN=0
    ldr r5, =0x40020800
    movs r1, #0x0B
    str r1, [r5, #8]             @ CH3 SPI1_TX
    ldr r6, =0x40020000
    movs r1, #1
    str r1, [r6, #0x34]          @ CH3 CNDTR
    ldr r1, =0x4001300C
    str r1, [r6, #0x38]          @ CH3 CPAR
    ldr r1, =0x20000010
    str r1, [r6, #0x3C]          @ CH3 CMAR
    movs r1, #0x91               @ EN|MINC|DIR, no request expected
    str r1, [r6, #0x30]          @ CH3 CCR
    movs r2, #0x400
delay:
    subs r2, r2, #1
    bne delay
    ldr r1, [r6, #0x34]          @ CH3 CNDTR must remain 1
    ldr r0, =0x20000000
    cmp r1, #1
    bne dmr_fail
    movs r1, #2
    str r1, [r0]
    b done
dmr_fail:
    movs r1, #3
    str r1, [r0]
done:
    b done

    .thumb_func
dma1_ch1_handler:
    push {r0, r1}
    ldr r0, =0x40020004
    movs r1, #2
    str r1, [r0]                 @ clear CH1 TCIF
    ldr r0, =0x20000000
    movs r1, #1
    str r1, [r0]
    pop {r0, r1}
    bx lr
