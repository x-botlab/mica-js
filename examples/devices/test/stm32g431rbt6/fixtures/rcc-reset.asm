.syntax unified
.thumb
.text
start:

    movw r0, #0x1000
    movt r0, #0x4002
    movs r1, #1
    str r1, [r0, #0x4c]       @ AHB2ENR.GPIOAEN
    movw r6, #0x0000
    movt r6, #0x4800          @ GPIOA
    movw r1, #0x0400
    str r1, [r6, #0x00]       @ PA5 output
    movs r1, #0x20
    str r1, [r6, #0x14]       @ PA5 high
    movw r1, #0x0000
    movt r1, #0x0002
    str r1, [r0, #0x58]       @ APB1ENR1.USART2EN
    movw r7, #0x4400
    movt r7, #0x4000          @ USART2
    movs r1, #9
    str r1, [r7, #0x00]       @ UE|TE
    movw r1, #0x022b
    str r1, [r7, #0x0c]       @ BRR
    movs r1, #0x41
    str r1, [r7, #0x28]       @ start 'A'
    movw r8, #0x00ff
wait:
    subs r8, r8, #1
    bne wait
    movw r1, #0x0000
    movt r1, #0x0002
    str r1, [r0, #0x38]       @ APB1RSTR1.USART2RST
    movs r1, #1
    str r1, [r0, #0x2c]       @ AHB2RSTR.GPIOARST
    ldr r2, [r7, #0x00]
    ldr r3, [r6, #0x00]
    movw r4, #0x0000
    movt r4, #0x2000
    str r2, [r4, #0x00]
    str r3, [r4, #0x04]
done:
    b done

.pool
