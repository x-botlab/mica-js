@ 系统外设真实固件回归：CRC / RNG / RTC / IWDG 喂狗 / DMA M2M / DMA USART2 TX。
@ 结果按顺序从 USART2 输出，供 board 测试读取 serial2.tx。
.syntax unified
.thumb

.section .isr_vector,"a",%progbits
.word 0x20005800
.word reset + 1
.rept 120
.word default_handler + 1
.endr

.section .text
.thumb_func
default_handler:
    b default_handler

.macro SEND_BYTE reg
1:
    ldr r2, [r9, #0x1c]
    tst r2, #0x80
    beq 1b
    str \reg, [r9, #0x28]
.endm

.global reset
.thumb_func
reset:
    @ RCC: DMA1/DMAMUX/CRC (AHB1), GPIOA/RNG (AHB2), USART2 (APB1)
    movw r0, #0x1000
    movt r0, #0x4002
    ldr r1, =0x00001005          @ DMA1EN | DMAMUX1EN | CRCEN
    str r1, [r0, #0x48]
    ldr r1, =0x04000001          @ GPIOAEN | RNGEN
    str r1, [r0, #0x4c]
    ldr r1, =0x00020000          @ USART2EN
    str r1, [r0, #0x58]

    @ GPIOA PA2/PA3 = AF7
    movw r0, #0x0000
    movt r0, #0x4800
    ldr r1, =0x000000a0          @ PA2/PA3 alternate function
    str r1, [r0, #0x00]
    ldr r1, =0x00007700          @ AFR0 PA2/PA3 = AF7
    str r1, [r0, #0x20]

    @ USART2 115200 8N1
    movw r9, #0x4400
    movt r9, #0x4000
    movs r1, #0
    str r1, [r9, #0x00]
    movs r1, #0x8b
    str r1, [r9, #0x0c]
    movs r1, #0x09
    str r1, [r9, #0x00]
    movs r1, #0x80              @ CR3.DMAT
    str r1, [r9, #0x08]

    @ CRC '123456789'
    movw r0, #0x3000
    movt r0, #0x4002
    movs r1, #0x31
    strb r1, [r0]
    movs r1, #0x32
    strb r1, [r0]
    movs r1, #0x33
    strb r1, [r0]
    movs r1, #0x34
    strb r1, [r0]
    movs r1, #0x35
    strb r1, [r0]
    movs r1, #0x36
    strb r1, [r0]
    movs r1, #0x37
    strb r1, [r0]
    movs r1, #0x38
    strb r1, [r0]
    movs r1, #0x39
    strb r1, [r0]
    ldr r4, [r0]
    mov r3, r4
    SEND_BYTE r3
    lsrs r3, r4, #8
    SEND_BYTE r3
    lsrs r3, r4, #16
    SEND_BYTE r3
    lsrs r3, r4, #24
    SEND_BYTE r3

.ifndef NO_RNG
    @ RNG enable + wait DRDY + read DR
    movw r0, #0x0800
    movt r0, #0x5006
    movs r1, #0x04
    str r1, [r0]
1:
    ldr r2, [r0, #0x04]
    tst r2, #1
    beq 1b
    ldr r5, [r0, #0x08]
    mov r3, r5
    SEND_BYTE r3
    lsrs r3, r5, #8
    SEND_BYTE r3
    lsrs r3, r5, #16
    SEND_BYTE r3
    lsrs r3, r5, #24
    SEND_BYTE r3

.endif
    @ RTC unlock/init/calendar 24-12-31 12:34:56
    movw r0, #0x2800
    movt r0, #0x4000
    ldr r1, =0x000000ca
    str r1, [r0, #0x24]
    ldr r1, =0x00000053
    str r1, [r0, #0x24]
    movs r1, #0x80
    str r1, [r0, #0x0c]
    ldr r1, =0x007f00ff
    str r1, [r0, #0x10]
    ldr r1, =0x00123456
    str r1, [r0, #0x00]
    ldr r1, =0x00245231
    str r1, [r0, #0x04]
    movs r1, #0
    str r1, [r0, #0x0c]
    ldr r6, [r0, #0x00]
    mov r3, r6
    SEND_BYTE r3
    lsrs r3, r6, #8
    SEND_BYTE r3
    lsrs r3, r6, #16
    SEND_BYTE r3
    lsrs r3, r6, #24
    SEND_BYTE r3

    @ IWDG start + immediate feed (must not reset)
    movw r0, #0x3000
    movt r0, #0x4000
    ldr r1, =0x00005555
    str r1, [r0]
    movs r1, #0
    str r1, [r0, #4]
    ldr r1, =0x00000fff
    str r1, [r0, #8]
    ldr r1, =0x0000cccc
    str r1, [r0]
    ldr r1, =0x0000aaaa
    str r1, [r0]
    movs r3, #0x57              @ 'W'
    SEND_BYTE r3

    @ DMA1 CH1 memory-to-memory: flash m2m_msg -> SRAM 0x20001000
    movw r0, #0x0000
    movt r0, #0x4002
    movs r1, #4
    str r1, [r0, #0x0c]
    ldr r1, =m2m_msg
    str r1, [r0, #0x10]
    movw r1, #0x1000
    movt r1, #0x2000
    str r1, [r0, #0x14]
    ldr r1, =0x000040c1
    str r1, [r0, #0x08]
1:
    ldr r2, [r0]
    tst r2, #2
    beq 1b

    movw r8, #0x1000
    movt r8, #0x2000
    movs r7, #4
2:
    ldrb r3, [r8], #1
    SEND_BYTE r3
    subs r7, #1
    bne 2b

    @ DMA1 CH2 memory-to-USART2 TX: flash dma_msg -> USART2 TDR
    movw r0, #0x0800
    movt r0, #0x4002
    movs r1, #0x1b              @ DMAMUX USART2_TX
    str r1, [r0, #0x04]
    movw r0, #0x0000
    movt r0, #0x4002
    movs r1, #5
    str r1, [r0, #0x20]         @ CH2 CNDTR (0x1c + 0x04)
    ldr r1, =0x40004428         @ USART2 TDR
    str r1, [r0, #0x24]         @ CH2 CPAR (0x1c + 0x08)
    ldr r1, =dma_msg
    str r1, [r0, #0x28]         @ CH2 CMAR (0x1c + 0x0c)
    movs r1, #0x91              @ EN | DIR | MINC
    str r1, [r0, #0x1c]         @ CH2 CCR
1:
    ldr r2, [r0]
    tst r2, #0x20               @ TCIF2
    beq 1b
3:
    b 3b

.align 2
m2m_msg:
    .ascii "M2M!"
dma_msg:
    .ascii "DMAOK"
