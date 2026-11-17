.syntax unified
.thumb
.text
start:

    movw r0, #0x1000
    movt r0, #0x4002          @ RCC
    movs r1, #1
    str r1, [r0, #0x4c]       @ GPIOA clock
    movw r6, #0x0000
    movt r6, #0x4800          @ GPIOA
    movs r1, #0x20
    str r1, [r6, #0x00]       @ PA2 alternate function
    movw r1, #0x0700
    str r1, [r6, #0x20]       @ AF7 on PA2
    movw r1, #0x0000
    movt r1, #0x0002
    str r1, [r0, #0x58]       @ USART2 clock
    movw r7, #0x4400
    movt r7, #0x4000          @ USART2
    movw r1, #0x022b
    str r1, [r7, #0x0c]       @ BRR = 34.6875
    movs r1, #9
    str r1, [r7, #0x00]       @ UE|TE
    movs r5, #0x40            @ ISR.TC
    movs r1, #0xff
    str r1, [r7, #0x28]       @ byte at 16 MHz
    bl wait_tc
    @ PLL 80 MHz, APB1=/2 -> PCLK1 40 MHz, APB2=/4 -> PCLK2 20 MHz
    movw r1, #0x1412
    movt r1, #0x0100
    str r1, [r0, #0x0c]
    ldr r1, [r0, #0x00]
    movw r2, #0x0000
    movt r2, #0x0100
    orrs r1, r1, r2
    str r1, [r0, #0x00]       @ PLLON
    movw r1, #0x2c03
    str r1, [r0, #0x08]       @ SW=PLL, PPRE1=/2, PPRE2=/4
    movs r1, #0xff
    str r1, [r7, #0x28]       @ byte at PCLK1 40 MHz
    bl wait_tc
    movs r1, #0x5a
    movw r2, #0x0400
    movt r2, #0x2000
    str r1, [r2]              @ marker at 0x20000400
done:
    b done
wait_tc:
    ldr r1, [r7, #0x1c]
    ands r1, r1, r5
    cmp r1, #0
    beq wait_tc
    bx lr

.pool
