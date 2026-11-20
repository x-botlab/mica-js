@ 共用初始化：向量表、USART1 PA9/PA10 AF7、16 MHz 下 115200 8N1。
@ 基址用 movw/movt，寄存器事实能证明静态地址，避免测试固件走延迟外设写路径。

.macro USART_VECTORS handler=default_handler
.section .isr_vector,"a",%progbits
.word 0x20005800
.word reset + 1
.rept 51
.word default_handler + 1
.endr
.word \handler + 1
.rept 10
.word default_handler + 1
.endr
.section .text
.endm

.macro USART1_INIT cr1=0x0d, brr=0x8b
    movw r0, #0x1000
    movt r0, #0x4002             @ RCC
    movs r1, #1
    str r1, [r0, #0x4c]          @ RCC->AHB2ENR: GPIOAEN
    movw r1, #0x4000
    str r1, [r0, #0x60]          @ RCC->APB2ENR: USART1EN
    movw r0, #0x0000
    movt r0, #0x4800             @ GPIOA
    ldr r1, =0x00a80000          @ PA9/PA10 MODER 位
    ldr r2, [r0, #0]
    bic r2, r2, r1
    ldr r1, =0x00280000          @ PA9/PA10 = AF
    orr r2, r2, r1
    orr r2, r2, #1               @ PA0 = 输出，作为 ready 指示
    str r2, [r0, #0]
    ldr r1, =0x00000ff0          @ AFR1 PA9/PA10 位
    ldr r2, [r0, #0x24]
    bic r2, r2, r1
    ldr r1, =0x00000770          @ AF7
    orr r2, r2, r1
    str r2, [r0, #0x24]
    movw r0, #0x3800
    movt r0, #0x4001             @ USART1
    movs r1, #0
    str r1, [r0, #0]             @ CR1=0
    movw r1, #\brr              @ BRR
    str r1, [r0, #0x0c]          @ BRR
    movs r1, #\cr1
    str r1, [r0, #0]             @ CR1
    @ 等 TEACK|REACK，确认启动握手
    ldr r2, =0x00600000
1:
    ldr r3, [r0, #0x1c]
    and r3, r3, r2
    cmp r3, r2
    bne 1b
    @ PA0 拉高，通知测试夹具已配置完成
    movw r0, #0x0000
    movt r0, #0x4800
    movs r1, #1
    str r1, [r0, #0x18]
.endm

.macro USART2_INIT cr1=0x0d, brr=0x8b
    ldr r0, =0x40021000
    movw r1, #0x0000
    movt r1, #0x0002             @ RCC_APB1ENR1.USART2EN (bit17)
    str r1, [r0, #0x58]
    movw r0, #0x0000
    movt r0, #0x4800             @ GPIOA
    ldr r1, =0x000000f0          @ PA2/PA3 MODER 位
    ldr r2, [r0, #0]
    bic r2, r2, r1
    ldr r1, =0x000000a0          @ PA2/PA3 = AF
    orr r2, r2, r1
    str r2, [r0, #0]
    ldr r1, =0x0000ff00          @ AFR0 PA2/PA3 位
    ldr r2, [r0, #0x20]
    bic r2, r2, r1
    ldr r1, =0x00007700          @ AF7
    orr r2, r2, r1
    str r2, [r0, #0x20]
    movw r0, #0x4400
    movt r0, #0x4000             @ USART2
    movs r1, #0
    str r1, [r0, #0]
    movw r1, #\brr
    str r1, [r0, #0x0c]
    movs r1, #\cr1
    str r1, [r0, #0]
    ldr r2, =0x00600000
1:
    ldr r3, [r0, #0x1c]
    and r3, r3, r2
    cmp r3, r2
    bne 1b
.endm

.macro USART1_NVIC
    movw r0, #0xe100
    movt r0, #0xe000
    movs r1, #0x20               @ IRQ37 -> ISER1 bit5（旧模型也读 ISER0 bit5）
    str r1, [r0, #4]
    str r1, [r0, #0]
.endm

.macro DEFAULT_HANDLER
.thumb_func
default_handler:
    b default_handler
.endm
