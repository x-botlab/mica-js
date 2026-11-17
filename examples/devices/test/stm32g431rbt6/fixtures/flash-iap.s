/* STM32G431RBT6 Flash IAP 固件。
 *
 * 从主 Flash 启动，配置 USART2，然后把 `sram_iap` 拷到 SRAM1 0x20000000 并跳转。
 * IAP 程序验证：锁定写拒绝、KEYR 解锁、页擦除回 0xFF、双字编程、1→0、EOP、再次
 * 擦除后把一段新代码写进 Flash 并跳过去执行。所有 32 位常量用 movw/movt，SRAM
 * 副本不依赖 Flash 中的 literal pool。
 */

  .syntax unified
  .thumb

  .section .isr_vector, "a", %progbits
  .word 0x20005800
  .word reset + 1

  .text
  .global reset

reset:
  /* RCC: GPIOA + USART2 时钟。 */
  movw r0, #0x1000
  movt r0, #0x4002
  movs r1, #1
  str r1, [r0, #0x48]
  movw r1, #0x0002
  movt r1, #0x0002
  str r1, [r0, #0x58]

  /* PA2 复用功能 7。 */
  movw r0, #0x0000
  movt r0, #0x4800
  movs r1, #0x20
  str r1, [r0, #0x00]
  movw r1, #0x0700
  str r1, [r0, #0x20]

  /* USART2 16 MHz 下 115200（沿用现有测试的 BRR）。 */
  movw r0, #0x4400
  movt r0, #0x4000
  movs r1, #0x8b
  str r1, [r0, #0x0c]
  movs r1, #9
  str r1, [r0, #0x00]

  /* 把 SRAM IAP 例程复制到 0x20000000。 */
  adr r1, sram_iap
  movw r2, #0x0000
  movt r2, #0x2000
  adr r3, sram_iap_end
copy_sram:
  ldr r4, [r1]
  str r4, [r2]
  adds r1, r1, #4
  adds r2, r2, #4
  cmp r1, r3
  blo copy_sram

  movw r4, #0x0001
  movt r4, #0x2000
  bx r4

/* ---- SRAM IAP 例程；运行时位于 0x20000000。 ---- */
  .align 2
sram_iap:
  movw r0, #0x4400
  movt r0, #0x4000          /* USART2 */
  movw r5, #0x2000
  movt r5, #0x4002          /* FLASH 控制器 */
  movw r6, #0xf000
  movt r6, #0x0801          /* page 62 = 0x0801f000 */

  /* 未解锁、PG=0 时写 Flash：PGSERR，映像不变。 */
  movw r3, #0xbeef
  movt r3, #0xdead
  str r3, [r6]
  ldr r4, [r6]
  cmp r4, r3
  beq fail
  ldr r1, [r5, #0x10]
  movs r2, #0x80
  ands r2, r2, r1
  cmp r2, #0
  beq fail
  movs r1, #0x80
  str r1, [r5, #0x10]       /* W1C PGSERR */
  movs r1, #'L'
  bl putc

  /* KEYR 解锁。 */
  movw r1, #0x0123
  movt r1, #0x4567
  str r1, [r5, #0x08]
  movw r1, #0x89ab
  movt r1, #0xcdef
  str r1, [r5, #0x08]
  ldr r1, [r5, #0x14]
  lsrs r1, r1, #31
  cmp r1, #0
  bne fail
  movs r1, #'U'
  bl putc

  /* 擦除 page 62。 */
  movw r1, #0x01f2          /* PER | PNB=62 */
  movt r1, #0x0001
  str r1, [r5, #0x14]       /* PER | PNB | STRT */
  bl wait_ready
  cmp r1, #0
  bne fail
  movs r1, #0
  str r1, [r5, #0x14]       /* 清 PER/PNB */
  ldr r4, [r6]
  movs r1, #0
  mvns r1, r1
  cmp r4, r1
  bne fail
  ldr r4, [r6, #0x7fc]
  cmp r4, r1
  bne fail
  movs r1, #'E'
  bl putc

  /* 编程一个双字：0x2149f8c0 / 0xe7fe1028，并置 EOPIE。 */
  movw r1, #0x0001
  movt r1, #0x0100
  str r1, [r5, #0x14]       /* PG | EOPIE */
  movw r1, #0x2149
  movt r1, #0xf8c0
  str r1, [r6]
  movw r1, #0x1028
  movt r1, #0xe7fe
  str r1, [r6, #4]
  bl wait_ready
  cmp r1, #0
  bne fail
  ldr r4, [r6]
  movw r1, #0x2149
  movt r1, #0xf8c0
  cmp r4, r1
  bne fail
  ldr r4, [r6, #4]
  movw r1, #0x1028
  movt r1, #0xe7fe
  cmp r4, r1
  bne fail
  ldr r1, [r5, #0x10]
  movs r2, #1
  ands r2, r2, r1
  cmp r2, #0
  beq fail
  movs r1, #1
  str r1, [r5, #0x10]       /* 清 EOP */
  movs r1, #0
  str r1, [r5, #0x14]       /* 清 PG/EOPIE */
  movs r1, #'P'
  bl putc

  /* 1→0：先写 0xffffff00，再尝试全 1；必须 PROGERR 且原值不变。 */
  movs r1, #1
  str r1, [r5, #0x14]
  movs r1, #0xff
  mvns r1, r1                /* 0xffffff00 */
  str r1, [r6, #8]
  movs r1, #0
  mvns r1, r1
  str r1, [r6, #0xc]
  bl wait_ready
  cmp r1, #0
  bne fail

  movs r1, #0
  mvns r1, r1
  str r1, [r6, #8]
  str r1, [r6, #0xc]
  ldr r1, [r5, #0x10]
  movs r2, #0x08
  ands r2, r2, r1
  cmp r2, #0
  beq fail
  ldr r4, [r6, #8]
  movs r1, #0xff
  mvns r1, r1
  cmp r4, r1
  bne fail
  movs r1, #0x08
  str r1, [r5, #0x10]       /* W1C PROGERR */
  movs r1, #0
  str r1, [r5, #0x14]       /* 清 PG */
  movs r1, #'N'
  bl putc

  /* 再擦 page 62，为写入并执行新代码做准备。 */
  movw r1, #0x01f2
  movt r1, #0x0001
  str r1, [r5, #0x14]
  bl wait_ready
  cmp r1, #0
  bne fail
  movs r1, #0
  str r1, [r5, #0x14]
  movs r1, #'R'
  bl putc

  /* 写入新代码：movs r1,#'I'; str r1,[r0,#0x28]; b . */
  movs r1, #1
  str r1, [r5, #0x14]
  movw r1, #0x2149
  movt r1, #0xf8c0
  str r1, [r6]
  movw r1, #0x1028
  movt r1, #0xe7fe
  str r1, [r6, #4]
  bl wait_ready
  cmp r1, #0
  bne fail
  movs r1, #0
  str r1, [r5, #0x14]       /* 清 PG */

  movs r1, #'J'
  bl putc
  movw r1, #0xf001
  movt r1, #0x0801
  bx r1

/* r1 = 0 成功，1 超时。 */
wait_ready:
  movw r7, #0xffff
  movt r7, #0x000f
wr_loop:
  ldr r1, [r5, #0x10]
  movw r2, #0x0000
  movt r2, #0x0001
  ands r2, r2, r1
  cmp r2, #0
  beq wr_done
  subs r7, r7, #1
  bne wr_loop
  movs r1, #1
  bx lr
wr_done:
  movs r1, #0
  bx lr

/* r1 = 字符。 */
putc:
  str r1, [r0, #0x28]
  bx lr

fail:
  movs r1, #'F'
  bl putc
  b .

  .align 2
sram_iap_end:
  .word 0
