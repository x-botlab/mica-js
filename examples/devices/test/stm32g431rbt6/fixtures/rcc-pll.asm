.syntax unified
.thumb
.text
start:

    movw r0, #0x1000
    movt r0, #0x4002          @ RCC
    @ PLL: HSI, M=2, N=20, PLLPEN, PLLPDIV=2, PLLREN -> VCO 160 MHz, R/P 80 MHz
    movw r1, #0x1412
    movt r1, #0x1101
    str r1, [r0, #0x0c]
    ldr r1, [r0, #0x00]
    movw r2, #0x0000
    movt r2, #0x0100
    orrs r1, r1, r2
    str r1, [r0, #0x00]       @ PLLON
    @ SW=PLL, HPRE=/1, PPRE1=/2, PPRE2=/4
    movw r1, #0x2c03
    str r1, [r0, #0x08]
    movs r1, #1
    str r1, [r0, #0x90]       @ BDCR.LSEON：USART3 选择 LSE
    @ USART1=SYSCLK, USART2=HSI, USART3=LSE,
    @ I2C1=SYSCLK, I2C2=HSI, I2C3=reserved, ADC12=PLLP
    movw r1, #0x9039
    movt r1, #0x1003
    str r1, [r0, #0x88]
done:
    b done

.pool
