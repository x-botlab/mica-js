/** Fixed CT117E-M4 digital MCU/LCD bus. Runtime code and model are self-contained. */
device Ct117eM4(
  clockFrequency: number default 80000000,
  hseFrequency: number default 0,
  refreshRate: number default 60,
) {
  pin VSS1;
  pin VDD1;
  pin NRST(low: 0.8, high: 2.0);
  assert isFinite(clockFrequency) && clockFrequency >= 1000 && clockFrequency <= 170000000,
    "clockFrequency must be a finite value within 1000..170000000";
  assert hseFrequency == 0 || (isFinite(hseFrequency) && hseFrequency >= 1000000 && hseFrequency <= 50000000),
    "hseFrequency must be 0 (not populated) or 1..50 MHz";
  memory code[0x20000];
  memory sram[0x5800];
  memory ccm[0x2800];
  memory periph[0x1000];
  memory sys[0x200];
  memory analog[0x400];
  memory i2c[0x200];
  memory spi[0x200];
  memory tim[0x300];
  memory serial[0x200];
  memory exti[0x100];
  memory syscfg[0x100];
  memory dma[0x400];
  memory crc[0x20];
  memory rng[0x20];
  memory rtc[0x100];
  memory watchdog[0x40];
  memory flashState[0x100];
  memory usb[0x800];
  /** 捕获 FIFO 保留布局；fused profile 暂无 TIM 引脚反应。 */
  memory captureFifo[0x400];
  memory can[0x800];
  memory ucpd[0x100];
  memory generic[0x2000];
  state r0: number = 0;
  state r1: number = 0;
  state r2: number = 0;
  state r3: number = 0;
  state r4: number = 0;
  state r5: number = 0;
  state r6: number = 0;
  state r7: number = 0;
  state r8: number = 0;
  state r9: number = 0;
  state r10: number = 0;
  state r11: number = 0;
  state r12: number = 0;
  state sp: number = 0;
  state lr: number = 0xffffffff;
  state apsr: number = 0x01000000;
  state primask: number = 0;
  state pc: number = 0;
  state pendingPs: number = 0;
  state cpuCyclePs: number = 0;
  state nowPs: number = 0;
  state tickPs: number = 1000000000000;
  state tickActive: bool = false;
  state periphActive: number = 0;
  state advancePending: number = 0;
  state advanceElapsedPs: number = 0;
  state periphDeadline0: number = 0;
  state periphDeadline1: number = 0;
  state periphDeadline2: number = 0;
  state periphDeadline3: number = 0;
  state periphDeadline4: number = 0;
  state periphDeadline5: number = 0;
  state periphDeadline6: number = 0;
  state periphDeadline7: number = 0;
  state periphDeadline8: number = 0;
  state periphDeadline9: number = 0;
  state periphDeadline10: number = 0;
  state periphDeadline11: number = 0;
  state periphDeadline12: number = 0;
  state periphDeadline13: number = 0;
  state periphDeadline14: number = 0;
  state periphDeadline15: number = 0;
  state serviceMask: number = 0;
  state captureHead: number = 0;
  state captureTail: number = 0;
  state capturePending: number = 0;
  state captureOverflow: number = 0;
  state captureResume: number = 0;
  state serviceResume: number = 0;
  state pollContinue: bool = false;
  state gpioSync: number = 0;
  state gpioPinMask: number = 0;
  state gpioPowered: bool = false;
  state gpioWrite: number = 0;
  state gpioWriteAddr: number = 0;
  state gpioWriteValue: number = 0;
  state gpioWriteSize: number = 4;
  state deferRead: bool = false;
  state deferReadPort: number = 0;
  state deferReadOffset: number = 0;
  state deferReadTarget: number = 0;
  state deferReadSize: number = 4;
  state deferReadSigned: bool = false;
  state deferReadModule: number = -1;
  state deferReadAddress: number = 0;
  state deferWrite: bool = false;
  state deferWriteAddr: number = 0;
  state deferWriteValue: number = 0;
  state deferWriteSize: number = 4;
  state deferWriteModule: number = -1;
  state gpioModer0: number = 0;
  state gpioModer1: number = 0;
  state gpioModer2: number = 0;
  state gpioModer3: number = 0;
  state gpioModer4: number = 0;
  state gpioOtyper0: number = 0;
  state gpioOtyper1: number = 0;
  state gpioOtyper2: number = 0;
  state gpioOtyper3: number = 0;
  state gpioOtyper4: number = 0;
  state gpioPupdr0: number = 0;
  state gpioPupdr1: number = 0;
  state gpioPupdr2: number = 0;
  state gpioPupdr3: number = 0;
  state gpioPupdr4: number = 0;
  state gpioAfr00: number = 0;
  state gpioAfr01: number = 0;
  state gpioAfr02: number = 0;
  state gpioAfr03: number = 0;
  state gpioAfr04: number = 0;
  state gpioAfr10: number = 0;
  state gpioAfr11: number = 0;
  state gpioAfr12: number = 0;
  state gpioAfr13: number = 0;
  state gpioAfr14: number = 0;
  state gpioOdr0: number = 0;
  state gpioOdr1: number = 0;
  state gpioOdr2: number = 0;
  state gpioOdr3: number = 0;
  state gpioOdr4: number = 0;
  state gpioSimpleOut0: number = 0;
  state gpioSimpleOut1: number = 0;
  state gpioSimpleOut2: number = 0;
  state gpioSimpleOut3: number = 0;
  state gpioSimpleOut4: number = 0;

  state gpioLck0: number = 0;
  state gpioLck1: number = 0;
  state gpioLck2: number = 0;
  state gpioLck3: number = 0;
  state gpioLck4: number = 0;
  state gpioLckStep0: number = 0;
  state gpioLckStep1: number = 0;
  state gpioLckStep2: number = 0;
  state gpioLckStep3: number = 0;
  state gpioLckStep4: number = 0;
  state irqDirty: bool = false;
  state systickOn: bool = false;
  state txMask: number = 0;
  state systickCtrl: number = 0;
  state systickLoad: number = 0;
  state systickVal: number = 0;
  state systickCount: number = 0;
  state systickPending: number = 0;
  state tx1Active: number = 0;
  state tx1Remaining: number = 0;
  state tx1Queue: number = 0;
  state tx1Count: number = 0;
  state tx1Period: number = 1;
  state tx1Publish: number = -1;
  state tx2Active: number = 0;
  state tx2Remaining: number = 0;
  state tx2Queue: number = 0;
  state tx2Count: number = 0;
  state tx2Period: number = 1;
  state tx2Publish: number = -1;
  state tx3Active: number = 0;
  state tx3Remaining: number = 0;
  state tx3Queue: number = 0;
  state tx3Count: number = 0;
  state tx3Period: number = 1;
  state tx3Publish: number = -1;
  /** TIM/DMA 模块内部状态；由各模块的 STATE_SPECS 生成，复位值都是 0。 */
  state timCenMask: number = 0;
  state timCaptureMask: number = 0;
  state tim1LastPs: number = 0;
  state tim1AccumPs: number = 0;
  state tim1Presc: number = 0;
  state tim1Rep: number = 0;
  state tim1ArrActive: number = 0;
  state tim1PscActive: number = 0;
  state tim1Ready: number = 0;
  state tim1Ccr1Active: number = 0;
  state tim1In1: number = 0;
  state tim1Cap1: number = 0;
  state tim1Out1: number = 0;
  state tim1Ccr2Active: number = 0;
  state tim1In2: number = 0;
  state tim1Cap2: number = 0;
  state tim1Out2: number = 0;
  state tim1Ccr3Active: number = 0;
  state tim1In3: number = 0;
  state tim1Cap3: number = 0;
  state tim1Out3: number = 0;
  state tim1Ccr4Active: number = 0;
  state tim1In4: number = 0;
  state tim1Cap4: number = 0;
  state tim1Out4: number = 0;
  state tim2LastPs: number = 0;
  state tim2AccumPs: number = 0;
  state tim2Presc: number = 0;
  state tim2Rep: number = 0;
  state tim2ArrActive: number = 0;
  state tim2PscActive: number = 0;
  state tim2Ready: number = 0;
  state tim2Ccr1Active: number = 0;
  state tim2In1: number = 0;
  state tim2Cap1: number = 0;
  state tim2Out1: number = 0;
  state tim2Ccr2Active: number = 0;
  state tim2In2: number = 0;
  state tim2Cap2: number = 0;
  state tim2Out2: number = 0;
  state tim2Ccr3Active: number = 0;
  state tim2In3: number = 0;
  state tim2Cap3: number = 0;
  state tim2Out3: number = 0;
  state tim2Ccr4Active: number = 0;
  state tim2In4: number = 0;
  state tim2Cap4: number = 0;
  state tim2Out4: number = 0;
  state tim3LastPs: number = 0;
  state tim3AccumPs: number = 0;
  state tim3Presc: number = 0;
  state tim3Rep: number = 0;
  state tim3ArrActive: number = 0;
  state tim3PscActive: number = 0;
  state tim3Ready: number = 0;
  state tim3Ccr1Active: number = 0;
  state tim3In1: number = 0;
  state tim3Cap1: number = 0;
  state tim3Out1: number = 0;
  state tim3Ccr2Active: number = 0;
  state tim3In2: number = 0;
  state tim3Cap2: number = 0;
  state tim3Out2: number = 0;
  state tim3Ccr3Active: number = 0;
  state tim3In3: number = 0;
  state tim3Cap3: number = 0;
  state tim3Out3: number = 0;
  state tim3Ccr4Active: number = 0;
  state tim3In4: number = 0;
  state tim3Cap4: number = 0;
  state tim3Out4: number = 0;
  state tim4LastPs: number = 0;
  state tim4AccumPs: number = 0;
  state tim4Presc: number = 0;
  state tim4Rep: number = 0;
  state tim4ArrActive: number = 0;
  state tim4PscActive: number = 0;
  state tim4Ready: number = 0;
  state tim4Ccr1Active: number = 0;
  state tim4In1: number = 0;
  state tim4Cap1: number = 0;
  state tim4Out1: number = 0;
  state tim4Ccr2Active: number = 0;
  state tim4In2: number = 0;
  state tim4Cap2: number = 0;
  state tim4Out2: number = 0;
  state tim4Ccr3Active: number = 0;
  state tim4In3: number = 0;
  state tim4Cap3: number = 0;
  state tim4Out3: number = 0;
  state tim4Ccr4Active: number = 0;
  state tim4In4: number = 0;
  state tim4Cap4: number = 0;
  state tim4Out4: number = 0;
  state tim6LastPs: number = 0;
  state tim6AccumPs: number = 0;
  state tim6Presc: number = 0;
  state tim6Rep: number = 0;
  state tim6ArrActive: number = 0;
  state tim6PscActive: number = 0;
  state tim6Ready: number = 0;
  state tim7LastPs: number = 0;
  state tim7AccumPs: number = 0;
  state tim7Presc: number = 0;
  state tim7Rep: number = 0;
  state tim7ArrActive: number = 0;
  state tim7PscActive: number = 0;
  state tim7Ready: number = 0;
  state tim8LastPs: number = 0;
  state tim8AccumPs: number = 0;
  state tim8Presc: number = 0;
  state tim8Rep: number = 0;
  state tim8ArrActive: number = 0;
  state tim8PscActive: number = 0;
  state tim8Ready: number = 0;
  state tim8Ccr1Active: number = 0;
  state tim8In1: number = 0;
  state tim8Cap1: number = 0;
  state tim8Out1: number = 0;
  state tim8Ccr2Active: number = 0;
  state tim8In2: number = 0;
  state tim8Cap2: number = 0;
  state tim8Out2: number = 0;
  state tim8Ccr3Active: number = 0;
  state tim8In3: number = 0;
  state tim8Cap3: number = 0;
  state tim8Out3: number = 0;
  state tim8Ccr4Active: number = 0;
  state tim8In4: number = 0;
  state tim8Cap4: number = 0;
  state tim8Out4: number = 0;
  state tim15LastPs: number = 0;
  state tim15AccumPs: number = 0;
  state tim15Presc: number = 0;
  state tim15Rep: number = 0;
  state tim15ArrActive: number = 0;
  state tim15PscActive: number = 0;
  state tim15Ready: number = 0;
  state tim15Ccr1Active: number = 0;
  state tim15In1: number = 0;
  state tim15Cap1: number = 0;
  state tim15Out1: number = 0;
  state tim15Ccr2Active: number = 0;
  state tim15In2: number = 0;
  state tim15Cap2: number = 0;
  state tim15Out2: number = 0;
  state tim16LastPs: number = 0;
  state tim16AccumPs: number = 0;
  state tim16Presc: number = 0;
  state tim16Rep: number = 0;
  state tim16ArrActive: number = 0;
  state tim16PscActive: number = 0;
  state tim16Ready: number = 0;
  state tim16Ccr1Active: number = 0;
  state tim16In1: number = 0;
  state tim16Cap1: number = 0;
  state tim16Out1: number = 0;
  state tim17LastPs: number = 0;
  state tim17AccumPs: number = 0;
  state tim17Presc: number = 0;
  state tim17Rep: number = 0;
  state tim17ArrActive: number = 0;
  state tim17PscActive: number = 0;
  state tim17Ready: number = 0;
  state tim17Ccr1Active: number = 0;
  state tim17In1: number = 0;
  state tim17Cap1: number = 0;
  state tim17Out1: number = 0;
  state dmaBusy: number = 0;

  /** UART4/LPUART1 的 RCC 复位路径使用与 USART1–3 同名的 state；内部相位仍可放 periph。 */
  state tx4Active: number = 0;
  state tx4Remaining: number = 0;
  state tx4Queue: number = 0;
  state tx4Count: number = 0;
  state tx4Period: number = 1;
  state tx4Publish: number = -1;
  state tx5Active: number = 0;
  state tx5Remaining: number = 0;
  state tx5Queue: number = 0;
  state tx5Count: number = 0;
  state tx5Period: number = 1;
  state tx5Publish: number = -1;

  state itState: number = 0;
  state halted: bool = false;
  state faultPc: number = 0;
  output channel fault: number(capacity: 16);
  output channel uart1Tx: number(capacity: 64, overflow: Overflow.drop_oldest);
  output channel uart2Tx: number(capacity: 64, overflow: Overflow.drop_oldest);
  output channel uart3Tx: number(capacity: 64, overflow: Overflow.drop_oldest);

  pure fn halDelayPoll() -> bool {
    return serviceMask != 0 || pollContinue || txMask != 0 || periphActive != 0 || !systickOn;
  }
  fn halDelayConsume() { pollContinue = false; }
  pure fn halDelayWaitPs() -> number {
    if !systickOn || txMask != 0 || periphActive != 0 || serviceMask != 0 || pollContinue { return 0; }
    const remaining = tickPs - pendingPs;
    return remaining > 0 ? remaining : 1;
  }
  fn halDelayAdvance(elapsedPs: number) {
    if !systickOn || txMask != 0 || periphActive != 0 || elapsedPs <= 0 { return; }
    const remaining = tickPs - pendingPs;
    if elapsedPs < remaining { return; }
    pendingPs = 0;
    nowPs = nowPs + elapsedPs;
    systickVal = systickLoad;
    systickCount = 1;
    if (systickCtrl & 2) != 0 {
      systickPending = 1;
      irqDirty = true;
      if primask == 0 {
        pollContinue = true;
        serviceResume = pc;
        serviceMask = serviceMask | 16;
        pc = 0x20000;
      }
    }
  }
  /** 外部 NRST 释放时的 MCU 复位；LCD 侧由独立 RST 与自身状态维护。 */
  fn mcuReset() {
    const resetCount = load32le(sys, 0x1fc);
    // RCC_BDCR 属备份域：NRST 与 SYSRESETREQ 一样保留 LSE/RTC 选择与 RTCEN。
    const backupDomain = load32le(periph, 0x90);
    r0 = 0; r1 = 0; r2 = 0; r3 = 0; r4 = 0; r5 = 0; r6 = 0; r7 = 0;
    r8 = 0; r9 = 0; r10 = 0; r11 = 0; r12 = 0;
    sp = 0;
    lr = 0xffffffff;
    apsr = 0x01000000;
    primask = 0;
    pc = 0;
    pendingPs = 0;
    cpuCyclePs = round(1000000000000 / clockFrequency);
    nowPs = 0;
    tickPs = 1000000000000;
    tickActive = false;
    periphActive = 0;
    advancePending = 0;
    advanceElapsedPs = 0;
    periphDeadline0 = 0; periphDeadline1 = 0; periphDeadline2 = 0; periphDeadline3 = 0;
    periphDeadline4 = 0; periphDeadline5 = 0; periphDeadline6 = 0; periphDeadline7 = 0;
    periphDeadline8 = 0; periphDeadline9 = 0; periphDeadline10 = 0; periphDeadline11 = 0;
    periphDeadline12 = 0; periphDeadline13 = 0; periphDeadline14 = 0; periphDeadline15 = 0;
    serviceMask = 0;
    captureHead = 0;
    captureTail = 0;
    capturePending = 0;
    captureOverflow = 0;
    captureResume = 0;
    serviceResume = 0;
    pollContinue = false;
    gpioSync = 0;
    gpioPinMask = 0;
    gpioPowered = false;
    gpioWrite = 0;
    gpioWriteAddr = 0;
    gpioWriteValue = 0;
    gpioWriteSize = 4;
    deferRead = false;
    deferReadPort = 0;
    deferReadOffset = 0;
    deferReadTarget = 0;
    deferReadSize = 4;
    deferReadSigned = false;
    deferReadModule = -1;
    deferReadAddress = 0;
    deferWrite = false;
    deferWriteAddr = 0;
    deferWriteValue = 0;
    deferWriteSize = 4;
    deferWriteModule = -1;
    gpioModer0 = 0; gpioModer1 = 0; gpioModer2 = 0; gpioModer3 = 0; gpioModer4 = 0;
    gpioOtyper0 = 0; gpioOtyper1 = 0; gpioOtyper2 = 0; gpioOtyper3 = 0; gpioOtyper4 = 0;
    gpioPupdr0 = 0; gpioPupdr1 = 0; gpioPupdr2 = 0; gpioPupdr3 = 0; gpioPupdr4 = 0;
    gpioAfr00 = 0; gpioAfr01 = 0; gpioAfr02 = 0; gpioAfr03 = 0; gpioAfr04 = 0;
    gpioAfr10 = 0; gpioAfr11 = 0; gpioAfr12 = 0; gpioAfr13 = 0; gpioAfr14 = 0;
    gpioOdr0 = 0; gpioOdr1 = 0; gpioOdr2 = 0; gpioOdr3 = 0; gpioOdr4 = 0;
    gpioSimpleOut0 = 0; gpioSimpleOut1 = 0; gpioSimpleOut2 = 0; gpioSimpleOut3 = 0; gpioSimpleOut4 = 0;
    gpioLck0 = 0; gpioLck1 = 0; gpioLck2 = 0; gpioLck3 = 0; gpioLck4 = 0;
    gpioLckStep0 = 0; gpioLckStep1 = 0; gpioLckStep2 = 0; gpioLckStep3 = 0; gpioLckStep4 = 0;
    irqDirty = false;
    systickOn = false;
    txMask = 0;
    systickCtrl = 0;
    systickLoad = 0;
    systickVal = 0;
    systickCount = 0;
    systickPending = 0;
    tx1Active = 0; tx1Remaining = 0; tx1Queue = 0; tx1Count = 0; tx1Period = 1; tx1Publish = -1;
    tx2Active = 0; tx2Remaining = 0; tx2Queue = 0; tx2Count = 0; tx2Period = 1; tx2Publish = -1;
    tx3Active = 0; tx3Remaining = 0; tx3Queue = 0; tx3Count = 0; tx3Period = 1; tx3Publish = -1;
    tx4Active = 0; tx4Remaining = 0; tx4Queue = 0; tx4Count = 0; tx4Period = 1; tx4Publish = -1;
    tx5Active = 0; tx5Remaining = 0; tx5Queue = 0; tx5Count = 0; tx5Period = 1; tx5Publish = -1;
    itState = 0;
    halted = false;
    faultPc = 0;

    // TIM/DMA 模块 state（STATE_SPECS 的复位值）。
    timCenMask = 0;
    timCaptureMask = 0;
    tim1LastPs = 0;
    tim1AccumPs = 0;
    tim1Presc = 0;
    tim1Rep = 0;
    tim1ArrActive = 0;
    tim1PscActive = 0;
    tim1Ready = 0;
    tim1Ccr1Active = 0;
    tim1In1 = 0;
    tim1Cap1 = 0;
    tim1Out1 = 0;
    tim1Ccr2Active = 0;
    tim1In2 = 0;
    tim1Cap2 = 0;
    tim1Out2 = 0;
    tim1Ccr3Active = 0;
    tim1In3 = 0;
    tim1Cap3 = 0;
    tim1Out3 = 0;
    tim1Ccr4Active = 0;
    tim1In4 = 0;
    tim1Cap4 = 0;
    tim1Out4 = 0;
    tim2LastPs = 0;
    tim2AccumPs = 0;
    tim2Presc = 0;
    tim2Rep = 0;
    tim2ArrActive = 0;
    tim2PscActive = 0;
    tim2Ready = 0;
    tim2Ccr1Active = 0;
    tim2In1 = 0;
    tim2Cap1 = 0;
    tim2Out1 = 0;
    tim2Ccr2Active = 0;
    tim2In2 = 0;
    tim2Cap2 = 0;
    tim2Out2 = 0;
    tim2Ccr3Active = 0;
    tim2In3 = 0;
    tim2Cap3 = 0;
    tim2Out3 = 0;
    tim2Ccr4Active = 0;
    tim2In4 = 0;
    tim2Cap4 = 0;
    tim2Out4 = 0;
    tim3LastPs = 0;
    tim3AccumPs = 0;
    tim3Presc = 0;
    tim3Rep = 0;
    tim3ArrActive = 0;
    tim3PscActive = 0;
    tim3Ready = 0;
    tim3Ccr1Active = 0;
    tim3In1 = 0;
    tim3Cap1 = 0;
    tim3Out1 = 0;
    tim3Ccr2Active = 0;
    tim3In2 = 0;
    tim3Cap2 = 0;
    tim3Out2 = 0;
    tim3Ccr3Active = 0;
    tim3In3 = 0;
    tim3Cap3 = 0;
    tim3Out3 = 0;
    tim3Ccr4Active = 0;
    tim3In4 = 0;
    tim3Cap4 = 0;
    tim3Out4 = 0;
    tim4LastPs = 0;
    tim4AccumPs = 0;
    tim4Presc = 0;
    tim4Rep = 0;
    tim4ArrActive = 0;
    tim4PscActive = 0;
    tim4Ready = 0;
    tim4Ccr1Active = 0;
    tim4In1 = 0;
    tim4Cap1 = 0;
    tim4Out1 = 0;
    tim4Ccr2Active = 0;
    tim4In2 = 0;
    tim4Cap2 = 0;
    tim4Out2 = 0;
    tim4Ccr3Active = 0;
    tim4In3 = 0;
    tim4Cap3 = 0;
    tim4Out3 = 0;
    tim4Ccr4Active = 0;
    tim4In4 = 0;
    tim4Cap4 = 0;
    tim4Out4 = 0;
    tim6LastPs = 0;
    tim6AccumPs = 0;
    tim6Presc = 0;
    tim6Rep = 0;
    tim6ArrActive = 0;
    tim6PscActive = 0;
    tim6Ready = 0;
    tim7LastPs = 0;
    tim7AccumPs = 0;
    tim7Presc = 0;
    tim7Rep = 0;
    tim7ArrActive = 0;
    tim7PscActive = 0;
    tim7Ready = 0;
    tim8LastPs = 0;
    tim8AccumPs = 0;
    tim8Presc = 0;
    tim8Rep = 0;
    tim8ArrActive = 0;
    tim8PscActive = 0;
    tim8Ready = 0;
    tim8Ccr1Active = 0;
    tim8In1 = 0;
    tim8Cap1 = 0;
    tim8Out1 = 0;
    tim8Ccr2Active = 0;
    tim8In2 = 0;
    tim8Cap2 = 0;
    tim8Out2 = 0;
    tim8Ccr3Active = 0;
    tim8In3 = 0;
    tim8Cap3 = 0;
    tim8Out3 = 0;
    tim8Ccr4Active = 0;
    tim8In4 = 0;
    tim8Cap4 = 0;
    tim8Out4 = 0;
    tim15LastPs = 0;
    tim15AccumPs = 0;
    tim15Presc = 0;
    tim15Rep = 0;
    tim15ArrActive = 0;
    tim15PscActive = 0;
    tim15Ready = 0;
    tim15Ccr1Active = 0;
    tim15In1 = 0;
    tim15Cap1 = 0;
    tim15Out1 = 0;
    tim15Ccr2Active = 0;
    tim15In2 = 0;
    tim15Cap2 = 0;
    tim15Out2 = 0;
    tim16LastPs = 0;
    tim16AccumPs = 0;
    tim16Presc = 0;
    tim16Rep = 0;
    tim16ArrActive = 0;
    tim16PscActive = 0;
    tim16Ready = 0;
    tim16Ccr1Active = 0;
    tim16In1 = 0;
    tim16Cap1 = 0;
    tim16Out1 = 0;
    tim17LastPs = 0;
    tim17AccumPs = 0;
    tim17Presc = 0;
    tim17Rep = 0;
    tim17ArrActive = 0;
    tim17PscActive = 0;
    tim17Ready = 0;
    tim17Ccr1Active = 0;
    tim17In1 = 0;
    tim17Cap1 = 0;
    tim17Out1 = 0;
    dmaBusy = 0;

    let at = 0;
    while at < 0x1000 { store8(periph, at, 0); at = at + 1; }
    store32le(periph, 0x90, backupDomain);
    at = 0;
    while at < 0x200 { store8(sys, at, 0); at = at + 1; }
    at = 0;
    while at < 0x400 { store8(analog, at, 0); at = at + 1; }
    at = 0;
    while at < 0x200 { store8(i2c, at, 0); at = at + 1; }
    at = 0;
    while at < 0x200 { store8(spi, at, 0); at = at + 1; }
    at = 0;
    while at < 0x300 { store8(tim, at, 0); at = at + 1; }
    at = 0;
    while at < 0x200 { store8(serial, at, 0); at = at + 1; }
    at = 0;
    while at < 0x100 { store8(exti, at, 0); at = at + 1; }
    at = 0;
    while at < 0x100 { store8(syscfg, at, 0); at = at + 1; }
    at = 0;
    while at < 0x400 { store8(dma, at, 0); at = at + 1; }
    at = 0;
    while at < 0x20 { store8(crc, at, 0); at = at + 1; }
    at = 0;
    while at < 0x20 { store8(rng, at, 0); at = at + 1; }
    // RTC 寄存器/日历在备份域，NRST 与 SYSRESETREQ 都保留。
    at = 0;
    while at < 0x40 { store8(watchdog, at, 0); at = at + 1; }
    // 选项字节/写保护跨 NRST 保留；标记 2 让 flash 模块下次访问只复位控制器寄存器。
    store32le(flashState, 0xfc, 0x464c5352);
    at = 0;
    while at < 0x2000 { store8(generic, at, 0); at = at + 1; }
    at = 0;
    while at < 0x800 { store8(usb, at, 0); at = at + 1; }
    at = 0;
    while at < 0x400 { store8(captureFifo, at, 0); at = at + 1; }
    at = 0;
    while at < 0x800 { store8(can, at, 0); at = at + 1; }
    at = 0;
    while at < 0x100 { store8(ucpd, at, 0); at = at + 1; }

    sp = load32le(code, 0);
    lr = 0xffffffff;
    pc = load32le(code, 4) & 0xfffffffe;
    store32le(sys, 0x1f8, 1);
    store32le(sys, 0x1fc, resetCount + 1);
    gpioSync = 31;
    serviceMask = serviceMask | 8;
    fusedI2cReset();
  }


  /** WFI：已有 service 或 pending IRQ 时不要 park。 */
  pure fn cpuWfiPoll() -> bool {
    return serviceMask != 0 || irqDirty;
  }

  /** WFE：event、service 或 pending IRQ 任一成立即可唤醒。 */
  pure fn cpuWfePoll() -> bool {
    return load32le(sys, 0x14c) != 0 || serviceMask != 0 || irqDirty;
  }

  /** 到下一个 service 节拍的时间；0 表示 park 到依赖变化。 */
  pure fn cpuWaitWaitPs() -> number {
    if !tickActive || serviceMask != 0 || irqDirty {
      return 0;
    }
    const remaining = tickPs - pendingPs;
    return remaining > 0 ? remaining : 1;
  }

  /**
   * polling deadline 到达后：只推进时间并进入现有 SERVICE_TICK。
   *
   * `serviceResume` 必须是等待指令 PC，而不是 `pc + 2`：没有真实 IRQ 时
   * SERVICE_TICK/DISPATCH 回到等待指令继续等；`waitNext` 只在异常被真正取走时
   * 作为异常栈返回地址（由中央的 `waitExceptionReturnPc` 读取）。
   */
  fn cpuWaitAdvance(elapsedPs: number) {
    if elapsedPs <= 0 {
      return;
    }
    pendingPs = pendingPs + elapsedPs;
    store32le(sys, 0x150, 1);       // waitActive
    store32le(sys, 0x154, pc);      // waitPc
    store32le(sys, 0x158, pc + 2);  // waitNext（WFI/WFE 都是 2 字节）
    serviceResume = pc;
    pc = 0x20000;
  }

  // BEGIN GENERATED TIM CAPTURE GATES (render-capture-gates.ts)
  pure fn captureArmed(pinId: number) -> bool {
    if pinId == 0 {
      return (load32le(periph, 0x4c) & 1) != 0
        && (load32le(periph, 0x2c) & 1) == 0
        && (load32le(periph, 0x58) & 1) != 0
        && (load32le(periph, 0x38) & 1) == 0
        && (load32le(tim, 0x48 + 0x00) & 1) != 0
        && ((load32le(tim, 0x48 + 0x18) >> 0) & 3) == 1
        && (load32le(tim, 0x48 + 0x20) & 1) != 0
        && ((gpioModer0 >> 30) & 3) == 2
        && ((gpioAfr10 >> 28) & 0xf) == 1;
    } else if pinId == 1 {
      return (load32le(periph, 0x4c) & 2) != 0
        && (load32le(periph, 0x2c) & 2) == 0
        && (load32le(periph, 0x58) & 2) != 0
        && (load32le(periph, 0x38) & 2) == 0
        && (load32le(tim, 0x90 + 0x00) & 1) != 0
        && ((load32le(tim, 0x90 + 0x18) >> 0) & 3) == 1
        && (load32le(tim, 0x90 + 0x20) & 1) != 0
        && ((gpioModer1 >> 8) & 3) == 2
        && ((gpioAfr01 >> 16) & 0xf) == 2;
    } else {
      return false;
    }
  }
  // END GENERATED TIM CAPTURE GATES

  process start {
    reset(false);
    sp = load32le(code, 0);
    lr = 0xffffffff;
    pc = load32le(code, 4) & 0xfffffffe;
    cpuCyclePs = round(1000000000000 / clockFrequency);
    buttonReady = true;
    potReady = true;
    fusedI2cStartup();
    fusedTimerStart();
  }

  assert isFinite(refreshRate) && refreshRate >= 1 && refreshRate <= 240,
    "refreshRate must be a finite value within 1..240";
  const PANEL_WIDTH = 320;
  const PANEL_HEIGHT = 240;
  const GRAM_WIDTH = 240;
  const GRAM_HEIGHT = 320;
  const MAX_BODY_BYTES = PANEL_WIDTH * PANEL_HEIGHT * 2;
  const FRAME_PERIOD_PS = round(1_000_000_000_000 / refreshRate);
  record FrameRect { x: number; y: number; width: number; height: number; }
  memory gram[PANEL_WIDTH * PANEL_HEIGHT * 2];
  memory regs[512];
  state index: number = 0;
  state entryMode: number = 0x1030;
  state addrX: number = 0;
  state addrY: number = 0;
  state windowX0: number = 0;
  state windowX1: number = GRAM_WIDTH - 1;
  state windowY0: number = 0;
  state windowY1: number = GRAM_HEIGHT - 1;
  state dirty: bool = false;
  state dirtyX0: number = 0;
  state dirtyX1: number = 0;
  state dirtyY0: number = 0;
  state dirtyY1: number = 0;
  state scheduled: bool = false;
  state frameSeq: number = 0;
  output channel frameInfo: FrameRect(capacity: 4096, overflow: Overflow.error);
  output channel frameRows: bytes(maxLength: MAX_BODY_BYTES, capacity: 4096,
                                  overflow: Overflow.error);
  derived readActive: bool = fusedWire19 == 0 && fusedWire18 == 0 && 1 != 0;
  fn dataBus() -> number {
    return (fusedWire0 == 1 ? 1 : 0) +
      2 * (fusedWire1 == 1 ? 1 : 0) +
      4 * (fusedWire2 == 1 ? 1 : 0) +
      8 * (fusedWire3 == 1 ? 1 : 0) +
      16 * (fusedWire4 == 1 ? 1 : 0) +
      32 * (fusedWire5 == 1 ? 1 : 0) +
      64 * (fusedWire6 == 1 ? 1 : 0) +
      128 * (fusedWire7 == 1 ? 1 : 0) +
      256 * (fusedWire8 == 1 ? 1 : 0) +
      512 * (fusedWire9 == 1 ? 1 : 0) +
      1024 * (fusedWire10 == 1 ? 1 : 0) +
      2048 * (fusedWire11 == 1 ? 1 : 0) +
      4096 * (fusedWire12 == 1 ? 1 : 0) +
      8192 * (fusedWire13 == 1 ? 1 : 0) +
      16384 * (fusedWire14 == 1 ? 1 : 0) +
      32768 * (fusedWire15 == 1 ? 1 : 0);
  }
  fn advanceAddress() {
    const xUp = (entryMode & 16) != 0;
    const yUp = (entryMode & 32) != 0;
    if (entryMode & 8) == 0 {
      addrX = addrX + (xUp ? 1 : -1);
      if addrX > windowX1 {
        addrX = windowX0;
        addrY = addrY + (yUp ? 1 : -1);
        if addrY > windowY1 { addrY = windowY0; }
        else if addrY < windowY0 { addrY = windowY1; }
      } else if addrX < windowX0 {
        addrX = windowX1;
        addrY = addrY + (yUp ? 1 : -1);
        if addrY > windowY1 { addrY = windowY0; }
        else if addrY < windowY0 { addrY = windowY1; }
      }
    } else {
      addrY = addrY + (yUp ? 1 : -1);
      if addrY > windowY1 {
        addrY = windowY0;
        addrX = addrX + (xUp ? 1 : -1);
        if addrX > windowX1 { addrX = windowX0; }
        else if addrX < windowX0 { addrX = windowX1; }
      } else if addrY < windowY0 {
        addrY = windowY1;
        addrX = addrX + (xUp ? 1 : -1);
        if addrX > windowX1 { addrX = windowX0; }
        else if addrX < windowX0 { addrX = windowX1; }
      }
    }
  }
  fn writeCommand(value: number) { index = value & 0xff; }
  fn writeData(value: number) {
    if index == 0x22 {
      let x = addrX;
      let y = addrY;
      const x0 = windowX0;
      const x1 = windowX1;
      const y0 = windowY0;
      const y1 = windowY1;
      const mode = entryMode;
      const stride = PANEL_WIDTH;
      if x >= x0 && x <= x1 && y >= y0 && y <= y1 &&
          x < GRAM_WIDTH && y < GRAM_HEIGHT {
        const column = stride - 1 - y;
        store16le(gram, (x * stride + column) * 2, value);
        fusedGramStores = fusedGramStores + 1;
        if dirty {
          if column < dirtyX0 { dirtyX0 = column; }
          else if column > dirtyX1 { dirtyX1 = column; }
          if x < dirtyY0 { dirtyY0 = x; }
          else if x > dirtyY1 { dirtyY1 = x; }
        } else {
          dirty = true;
          dirtyX0 = column;
          dirtyX1 = column;
          dirtyY0 = x;
          dirtyY1 = x;
        }
        if !scheduled {
          scheduled = true;
          fusedFramePending = true;
        }
      }
      if (mode & 8) == 0 {
        x = x + ((mode & 16) != 0 ? 1 : -1);
        if x > x1 || x < x0 {
          x = x > x1 ? x0 : x1;
          y = y + ((mode & 32) != 0 ? 1 : -1);
          if y > y1 { y = y0; }
          else if y < y0 { y = y1; }
          addrY = y;
        }
        addrX = x;
      } else {
        y = y + ((mode & 32) != 0 ? 1 : -1);
        if y > y1 || y < y0 {
          y = y > y1 ? y0 : y1;
          x = x + ((mode & 16) != 0 ? 1 : -1);
          if x > x1 { x = x0; }
          else if x < x0 { x = x1; }
          addrX = x;
        }
        addrY = y;
      }
    } else {
      store16le(regs, index * 2, value);
      if index == 0x20 {
        addrX = value & 0xff;
        store16le(regs, index * 2, addrX);
      } else if index == 0x21 {
        addrY = value & 0x1ff;
        store16le(regs, index * 2, addrY);
      } else if index == 0x03 {
        entryMode = value;
      } else if index == 0x50 {
        const next = value & 0xff;
        if next <= windowX1 { windowX0 = next; }
        store16le(regs, index * 2, windowX0);
      } else if index == 0x51 {
        const next = value & 0xff;
        if next >= windowX0 && next < GRAM_WIDTH { windowX1 = next; }
        store16le(regs, index * 2, windowX1);
      } else if index == 0x52 {
        const next = value & 0x1ff;
        if next <= windowY1 { windowY0 = next; }
        store16le(regs, index * 2, windowY0);
      } else if index == 0x53 {
        const next = value & 0x1ff;
        if next >= windowY0 && next < GRAM_HEIGHT { windowY1 = next; }
        store16le(regs, index * 2, windowY1);
      }
    }
  }
  fn readValue() -> number {
    let fusedResult = 0;
    if fusedWire17 != 1 { fusedResult = 0; }
    else if index == 0x00 { fusedResult = 0x9325; }
    else if index == 0x20 { fusedResult = addrX; }
    else if index == 0x21 { fusedResult = addrY; }
    else if index == 0x22 {
      const value = load16le(gram,
        (addrX * PANEL_WIDTH + (PANEL_WIDTH - 1) - addrY) * 2);
      advanceAddress();
      fusedResult = value;
    } else { fusedResult = load16le(regs, index * 2); }
    return fusedResult;
  }
  fn driveData(value: number) {
    fusedReadValue = value;
    fusedReading = true;
  }
  fn releaseData() { fusedReading = false; }
  fn clearGram() {
    let offset = 0;
    while offset < PANEL_WIDTH * PANEL_HEIGHT * 2 {
      store16le(gram, offset, 0);
      offset = offset + 2;
    }
  }
  fn reset(clearPixels: bool) {
    index = 0;
    entryMode = 0x1030;
    addrX = 0;
    addrY = 0;
    windowX0 = 0;
    windowX1 = GRAM_WIDTH - 1;
    windowY0 = 0;
    windowY1 = GRAM_HEIGHT - 1;
    let reg = 0;
    while reg < 512 {
      store8(regs, reg, 0);
      reg = reg + 1;
    }
    store16le(regs, 0x03 * 2, entryMode);
    store16le(regs, 0x20 * 2, addrX);
    store16le(regs, 0x21 * 2, addrY);
    store16le(regs, 0x50 * 2, windowX0);
    store16le(regs, 0x51 * 2, windowX1);
    store16le(regs, 0x52 * 2, windowY0);
    store16le(regs, 0x53 * 2, windowY1);
    releaseData();
    if clearPixels {
      clearGram();
      dirty = true;
      dirtyX0 = 0;
      dirtyX1 = PANEL_WIDTH - 1;
      dirtyY0 = 0;
      dirtyY1 = PANEL_HEIGHT - 1;
      if !scheduled {
        scheduled = true;
        fusedFramePending = true;
      }
    }
  }
  process publishFrames on frameSeq {
    if dirty {
      await ticks(FRAME_PERIOD_PS);
      const x = dirtyX0;
      const y = dirtyY0;
      const width = dirtyX1 - dirtyX0 + 1;
      const height = dirtyY1 - dirtyY0 + 1;
      const info: FrameRect = { x: x, y: y, width: width, height: height };
      frameInfo.send(info);
      if width == PANEL_WIDTH || height == 1 {
        frameRows.send(copyBytes(gram, (y * PANEL_WIDTH + x) * 2, width * height * 2));
      } else {
        let row = 0;
        while row < height {
          frameRows.send(copyBytes(gram, ((y + row) * PANEL_WIDTH + x) * 2, width * 2));
          row = row + 1;
        }
      }
      dirty = false;
    }
    scheduled = false;
  }

  state fusedWire0: number = -1;
  state fusedWire1: number = -1;
  state fusedWire2: number = -1;
  state fusedWire3: number = -1;
  state fusedWire4: number = -1;
  state fusedWire5: number = -1;
  state fusedWire6: number = -1;
  state fusedWire7: number = -1;
  state fusedWire8: number = -1;
  state fusedWire9: number = -1;
  state fusedWire10: number = -1;
  state fusedWire11: number = -1;
  state fusedWire12: number = -1;
  state fusedWire13: number = -1;
  state fusedWire14: number = -1;
  state fusedWire15: number = -1;
  state fusedWire16: number = -1;
  state fusedWire17: number = -1;
  state fusedWire18: number = -1;
  state fusedWire19: number = -1;
  /** 板载器件内部线：PD2、PA0、PB0、PB1、PB2、PB6、PB7、PB12、PB14、PB15、PA15、PB4。 */
  state fusedWire20: number = -1;
  state fusedWire21: number = -1;
  state fusedWire22: number = -1;
  state fusedWire23: number = -1;
  state fusedWire24: number = -1;
  state fusedWire25: number = -1;
  state fusedWire26: number = -1;
  state fusedWire27: number = -1;
  state fusedWire28: number = -1;
  state fusedWire29: number = -1;
  state fusedWire30: number = -1;
  state fusedWire31: number = -1;

  /**
   * U1 74HC573：LE=PD2、OE#=GND；PC8–PC15 与 LCD 高字节共用。
   *
   * 内部 `ledLatch`/`ledBits` 保存 Q 字节（Q=D）。LED 阳极接 VDD，Q=0 点亮，
   * 因此公共 `ledState` 取反后再输出；上电把 Q 置为全 1（LED 全灭），这是模型
   * 对 573 上电未知状态的确定性安全初值。
   */
  state ledLatch: number = 255;
  /**
   * 573 的真实语义：LE 高时 Q 透明跟随 D；LE 低时保持最后一个电平。
   * D 脚在 LCD 读周期看到的是 LCD 驱动值，不是 MCU 的 fusedWire 意图。
   */
  derived ledBits: number =
    ((fusedReading ? (fusedReadValue >> 8) & 1 : fusedWire8) == 1 ? 1 : 0) +
    2 * ((fusedReading ? (fusedReadValue >> 9) & 1 : fusedWire9) == 1 ? 1 : 0) +
    4 * ((fusedReading ? (fusedReadValue >> 10) & 1 : fusedWire10) == 1 ? 1 : 0) +
    8 * ((fusedReading ? (fusedReadValue >> 11) & 1 : fusedWire11) == 1 ? 1 : 0) +
    16 * ((fusedReading ? (fusedReadValue >> 12) & 1 : fusedWire12) == 1 ? 1 : 0) +
    32 * ((fusedReading ? (fusedReadValue >> 13) & 1 : fusedWire13) == 1 ? 1 : 0) +
    64 * ((fusedReading ? (fusedReadValue >> 14) & 1 : fusedWire14) == 1 ? 1 : 0) +
    128 * ((fusedReading ? (fusedReadValue >> 15) & 1 : fusedWire15) == 1 ? 1 : 0);
  derived ledQ: number = fusedWire20 == 1 ? ledBits : ledLatch;
  /** 公共掩码：bit0=LD1 … bit7=LD8，1=亮。 */
  derived ledState: number = 255 - ledQ;
  /** blue-led 的线性等效：3.3 V / (500 Ω LED + 300 Ω 限流 + 25 Ω 驱动)。 */
  const LED_ON_BRIGHTNESS = (3.3 / (500 + 300 + 25)) / 0.02;
  derived ledBrightness0: number = (ledState & 1) != 0 ? LED_ON_BRIGHTNESS : 0;
  derived ledBrightness1: number = (ledState & 2) != 0 ? LED_ON_BRIGHTNESS : 0;
  derived ledBrightness2: number = (ledState & 4) != 0 ? LED_ON_BRIGHTNESS : 0;
  derived ledBrightness3: number = (ledState & 8) != 0 ? LED_ON_BRIGHTNESS : 0;
  derived ledBrightness4: number = (ledState & 16) != 0 ? LED_ON_BRIGHTNESS : 0;
  derived ledBrightness5: number = (ledState & 32) != 0 ? LED_ON_BRIGHTNESS : 0;
  derived ledBrightness6: number = (ledState & 64) != 0 ? LED_ON_BRIGHTNESS : 0;
  derived ledBrightness7: number = (ledState & 128) != 0 ? LED_ON_BRIGHTNESS : 0;

  /** B1=PB0、B2=PB1、B3=PB2、B4=PA0；按下为 true。 */
  state button1: bool = false;
  state button2: bool = false;
  state button3: bool = false;
  state button4: bool = false;
  /** 启动后置位，让两个输入接收过程常驻等待；不需要每次 set 都重新触发。 */
  state buttonReady: bool = false;
  state potReady: bool = false;
  /** R37/PB15=VDD–GND 分压（id 1）、R38/PB12（id 2）。 */
  state pot1: number = 0.5;
  state pot2: number = 0.5;
  /**
   * PB14 的 MCP4017 滑臂模拟源（ADC1_IN5）。§2 的 I²C 模型接入后写电压并置
   * valid；此前 ADC 读 PB14 必须得到浮空/无数据，而不是伪造的 0 V。
   */
  state fusedWiperVoltage: number = 0;
  state fusedWiperValid: bool = false;

  record ButtonState {
    id: number;
    pressed: bool;
  }
  record PotentiometerState {
    id: number;
    position: number;
  }

  output channel led: number(capacity: 16, overflow: Overflow.drop_oldest);
  input channel setButton: ButtonState(capacity: 16, overflow: Overflow.error);
  output channel button: ButtonState(capacity: 16, overflow: Overflow.drop_oldest);
  input channel setPotentiometer: PotentiometerState(capacity: 16, overflow: Overflow.error);
  output channel potentiometer: PotentiometerState(capacity: 16, overflow: Overflow.drop_oldest);

  state fusedWrChanges: number = 0;
  state fusedWrites: number = 0;
  state fusedReading: bool = false;
  state fusedReadValue: number = 0;
  state fusedGramStores: number = 0;
  state fusedFramePending: bool = false;
  state fusedFrameResume: number = 0;
  state fusedFrameDelay: number = 0;

  // ==== BEGIN PASTE ====
  const I2C_IDLE = 0;
  const I2C_ADDRESS = 1;
  const I2C_ACK = 2;
  const I2C_EEPROM_WORD = 3;
  const I2C_EEPROM_DATA = 4;
  const I2C_EEPROM_READ = 5;
  const I2C_EEPROM_MASTER_ACK = 6;
  const I2C_POT_DATA = 7;
  const I2C_POT_READ = 8;
  const I2C_POT_MASTER_ACK = 9;
  const I2C_IGNORE = 10;

  const I2C_DEVICE_EEPROM = 1;
  const I2C_DEVICE_POT = 2;
  const I2C_ADDRESS_EEPROM = 0x50;
  const I2C_ADDRESS_POT = 0x2f;
  const I2C_POR_WIPER = 0x3f;

  const MCP_RAB = 100_000;
  const MCP_RW = 100;
  const MCP_PULLUP = 10_000;
  const BOARD_VDD = 3.3;

  record EepromWrite {
    address: number;
    value: number;
  }

  /** 256 B 映像保持 public，宿主 readEeprom 直接读取该内存快照。 */
  public memory eeprom[256];

  output channel eepromWrite: EepromWrite(capacity: 300, overflow: Overflow.drop_oldest);
  output channel wiper: number(capacity: 16, overflow: Overflow.drop_oldest);

  /** [address, data...]；data 至少 1 B，最多 256 B。队列满必须报错。 */
  input channel writeEeprom: bytes(maxLength: 257, capacity: 16, overflow: Overflow.error);
  input channel setWiper: number(capacity: 16, overflow: Overflow.error);

  state i2cHostReady: bool = false;
  state i2cPrevBusScl: number = 1;
  state i2cPrevBusSda: number = 1;
  state i2cSdaLow: bool = false;
  state i2cPhase: number = I2C_IDLE;
  state i2cShift: number = 0;
  state i2cBits: number = 0;
  state i2cNextPhase: number = I2C_IDLE;
  state i2cTransmitByte: number = 0;
  state i2cTransmitBits: number = 0;
  state i2cMasterAck: bool = false;
  state i2cMasterAckSampled: bool = false;
  state i2cPendingWiper: number = I2C_POR_WIPER;
  state i2cPendingWrite: bool = false;
  state eepromPointer: number = 0;
  state potWiper: number = I2C_POR_WIPER;

  /**
   * 主控是否真的在主动拉低这根脚。
   *
   * `fusedWire` 的 0 只表示意图朝地：PUPDR 弱下拉也会给出 0，但那不是开漏主动
   * 拉低。只有 GPIOB 时钟开、VDD 有效、MODER=GPIO 输出且 ODR=0 才成立。
   */
  fn fusedI2cPinDrivenLow(bit: number, wireLevel: number) -> bool {
    if wireLevel != 0 { return false; }
    if !gpioPowered { return false; }
    if (load32le(periph, 0x4c) & 2) == 0 { return false; }
    const mode = (gpioModer1 >> (bit * 2)) & 3;
    if mode != 1 { return false; }
    return ((gpioOdr1 >> bit) & 1) == 0;
  }

  fn fusedI2cMasterScl() -> number {
    return fusedI2cPinDrivenLow(6, fusedWire25) ? 0 : 1;
  }

  fn fusedI2cMasterSda() -> number {
    return fusedI2cPinDrivenLow(7, fusedWire26) ? 0 : 1;
  }

  /** SCL 只由主控驱动，从机不拉伸。 */
  fn fusedI2cScl() -> number {
    return fusedI2cMasterScl();
  }

  /** SDA 开漏合成：主控主动拉低或从机 ACK/读 0 时才是低。 */
  fn fusedI2cSda() -> number {
    if fusedI2cMasterSda() == 0 || i2cSdaLow {
      return 0;
    }
    return 1;
  }

  fn i2cWiperVoltage() -> number {
    const wiperCode = potWiper & 0x7f;
    const rwb = MCP_RAB * wiperCode / 127 + MCP_RW;
    return BOARD_VDD * rwb / (MCP_PULLUP + rwb);
  }

  /** 丢弃未完成的总线事务并释放 SDA；EEPROM/wiper/地址指针不受影响。 */
  fn i2cResetBus() {
    i2cSdaLow = false;
    i2cPhase = I2C_IDLE;
    i2cShift = 0;
    i2cBits = 0;
    i2cNextPhase = I2C_IDLE;
    i2cTransmitByte = 0;
    i2cTransmitBits = 0;
    i2cMasterAck = false;
    i2cMasterAckSampled = false;
    i2cPendingWrite = false;
  }

  /** MCU 复位：释放总线并要求下一次调用从空闲高电平重新观察。 */
  fn fusedI2cReset() {
    i2cResetBus();
    i2cPrevBusScl = 1;
    i2cPrevBusSda = 1;
  }

  /** 现有 process start 调用：发布 POR wiper/电压，但不重置 EEPROM 或指针。 */
  fn fusedI2cStartup() {
    fusedI2cReset();
    fusedWiperVoltage = i2cWiperVoltage();
    fusedWiperValid = true;
    wiper.send(potWiper);
  }

  fn i2cAcknowledge(next: number) {
    i2cNextPhase = next;
    i2cSdaLow = true;
    i2cPhase = I2C_ACK;
  }

  fn i2cStoreEeprom(address: number, value: number) {
    const slot = address & 255;
    const next = value & 255;
    const previous = load8(eeprom, slot);
    if previous != next {
      store8(eeprom, slot, next);
      eepromWrite.send({ address: slot, value: next });
    }
  }

  fn i2cApplyWiper(nextCode: number) {
    const next = nextCode & 0x7f;
    if next != potWiper {
      potWiper = next;
      fusedWiperVoltage = i2cWiperVoltage();
      fusedWiperValid = true;
      wiper.send(next);
    }
  }

  /** 通用读位推进：8 个数据位之后释放 SDA 并进入指定 master-ack 相位。 */
  fn i2cPlaceTransmitBit(masterAckPhase: number) {
    if i2cTransmitBits < 8 {
      const bit = (i2cTransmitByte >> (7 - i2cTransmitBits)) & 1;
      i2cSdaLow = bit == 0;
      i2cTransmitBits = i2cTransmitBits + 1;
    } else {
      i2cSdaLow = false;
      i2cPhase = masterAckPhase;
      i2cMasterAckSampled = false;
    }
  }

  fn i2cBeginTransmit(value: number, readPhase: number, masterAckPhase: number) {
    i2cTransmitByte = value & 0xff;
    i2cTransmitBits = 0;
    i2cPhase = readPhase;
    i2cPlaceTransmitBit(masterAckPhase);
  }

  /** 读事务的公共入口；EEPROM 指针只在真正装入发送字节时前进。 */
  fn i2cBeginRead(kind: number) {
    if kind == I2C_DEVICE_EEPROM {
      const value = load8(eeprom, eepromPointer & 255);
      eepromPointer = (eepromPointer + 1) & 255;
      i2cBeginTransmit(value, I2C_EEPROM_READ, I2C_EEPROM_MASTER_ACK);
    } else {
      i2cBeginTransmit(potWiper & 0x7f, I2C_POT_READ, I2C_POT_MASTER_ACK);
    }
  }

  /** 主机第 9 个时钟的 ACK/NACK：ACK 继续读同一器件，NACK 结束并释放。 */
  fn i2cHandleMasterAck(kind: number) {
    if !i2cMasterAckSampled { return; }
    if i2cMasterAck {
      i2cBeginRead(kind);
    } else {
      i2cSdaLow = false;
      i2cPhase = I2C_IGNORE;
    }
  }

  fn i2cFinishAddress(byte: number) {
    const address = byte >> 1;
    if address == I2C_ADDRESS_EEPROM {
      if (byte & 1) == 1 {
        i2cAcknowledge(I2C_EEPROM_READ);
      } else {
        i2cAcknowledge(I2C_EEPROM_WORD);
      }
    } else if address == I2C_ADDRESS_POT {
      if (byte & 1) == 1 {
        i2cAcknowledge(I2C_POT_READ);
      } else {
        i2cAcknowledge(I2C_POT_DATA);
      }
    } else {
      // 未命中任何实际器件：不 ACK，也不在忽略阶段驱动 SDA。
      i2cSdaLow = false;
      i2cPhase = I2C_IGNORE;
    }
  }

  fn i2cFinishReceivedByte() {
    const byte = i2cShift;
    i2cShift = 0;
    i2cBits = 0;

    if i2cPhase == I2C_ADDRESS {
      i2cFinishAddress(byte);
    } else if i2cPhase == I2C_EEPROM_WORD {
      eepromPointer = byte;
      i2cAcknowledge(I2C_EEPROM_DATA);
    } else if i2cPhase == I2C_EEPROM_DATA {
      // 本板 WC# 固定为 GND，字节写总是落盘；页内指针按 8 B 回卷。
      i2cStoreEeprom(eepromPointer & 255, byte);
      eepromPointer = (eepromPointer & 248) | ((eepromPointer + 1) & 7);
      i2cAcknowledge(I2C_EEPROM_DATA);
    } else if i2cPhase == I2C_POT_DATA {
      // 数据先暂存，第 9 个下降沿（ACK 结束）才提交。
      i2cPendingWiper = byte & 0x7f;
      i2cPendingWrite = true;
      i2cAcknowledge(I2C_POT_DATA);
    }
  }

  fn i2cRising(busSda: number) {
    const receiving = i2cPhase == I2C_ADDRESS ||
      i2cPhase == I2C_EEPROM_WORD ||
      i2cPhase == I2C_EEPROM_DATA ||
      i2cPhase == I2C_POT_DATA;
    if receiving && i2cBits < 8 {
      i2cShift = (i2cShift << 1) | busSda;
      i2cBits = i2cBits + 1;
    } else if (i2cPhase == I2C_EEPROM_MASTER_ACK || i2cPhase == I2C_POT_MASTER_ACK) &&
        !i2cMasterAckSampled {
      // 主控拉低 = ACK（继续发送）；释放 = NACK。
      i2cMasterAck = busSda == 0;
      i2cMasterAckSampled = true;
    }
  }

  fn i2cFalling() {
    const receiving = i2cPhase == I2C_ADDRESS ||
      i2cPhase == I2C_EEPROM_WORD ||
      i2cPhase == I2C_EEPROM_DATA ||
      i2cPhase == I2C_POT_DATA;
    if receiving && i2cBits == 8 {
      i2cFinishReceivedByte();
    } else if i2cPhase == I2C_ACK {
      // 第 9 个下降沿退出应答：先释放 SDA，再进入下一相位。
      i2cSdaLow = false;
      if i2cPendingWrite {
        i2cApplyWiper(i2cPendingWiper);
        i2cPendingWrite = false;
      }
      const next = i2cNextPhase;
      if next == I2C_EEPROM_READ {
        i2cBeginRead(I2C_DEVICE_EEPROM);
      } else if next == I2C_POT_READ {
        i2cBeginRead(I2C_DEVICE_POT);
      } else {
        i2cPhase = next;
        i2cShift = 0;
        i2cBits = 0;
      }
    } else if i2cPhase == I2C_EEPROM_READ {
      i2cPlaceTransmitBit(I2C_EEPROM_MASTER_ACK);
    } else if i2cPhase == I2C_POT_READ {
      i2cPlaceTransmitBit(I2C_POT_MASTER_ACK);
    } else if i2cPhase == I2C_EEPROM_MASTER_ACK {
      i2cHandleMasterAck(I2C_DEVICE_EEPROM);
    } else if i2cPhase == I2C_POT_MASTER_ACK {
      i2cHandleMasterAck(I2C_DEVICE_POT);
    }
  }

  /**
   * 每一条触碰 PB6/PB7 的 MCU 指令结束后调用一次。
   *
   * 先按物理总线电平比较 START/STOP，再处理 SCL 边沿。这样从机 ACK/读 0 正在
   * 拉低 SDA 时，主控释放或再次拉低都不会被误判为 START/STOP。
   */
  fn fusedI2c() {
    const busScl = fusedI2cMasterScl();
    const busSda = fusedI2cSda();
    const previousScl = i2cPrevBusScl;
    const previousSda = i2cPrevBusSda;

    if previousScl == 1 && busScl == 1 && previousSda == 1 && busSda == 0 {
      // 物理 START / repeated START：重新收地址；未提交的 MCP 数据丢弃。
      i2cResetBus();
      i2cPhase = I2C_ADDRESS;
    } else if previousScl == 1 && busScl == 1 && previousSda == 0 && busSda == 1 {
      // 物理 STOP：释放 SDA；未提交的 MCP 数据丢弃。
      i2cResetBus();
    } else if previousScl == 0 && busScl == 1 {
      i2cRising(busSda);
    } else if previousScl == 1 && busScl == 0 {
      i2cFalling();
    }

    // 状态机可能在本调用内改变从机拉低状态；保存调用结束后的物理总线。
    i2cPrevBusScl = busScl;
    i2cPrevBusSda = fusedI2cSda();
  }

  process i2cHostEeprom on i2cHostReady {
    loop {
      const command = await writeEeprom.receive();
      assert command.length >= 2 && command.length <= 257,
        "writeEeprom payload must be [address, 1..256 data bytes]";
      let at = 1;
      let pointer = command[0] & 255;
      while at < command.length {
        i2cStoreEeprom(pointer, command[at]);
        pointer = (pointer + 1) & 255;
        at = at + 1;
      }
    }
  }

  process i2cHostWiper on i2cHostReady {
    loop {
      const value = await setWiper.receive();
      assert isSafeInteger(value) && value >= 0 && value <= 127,
        "setWiper must be an integer within 0..127";
      i2cApplyWiper(value);
    }
  }
  // ==== END PASTE ====

  fn fusedWr(previous: number) {
    const next = fusedWire16;
    if previous != next { fusedWrChanges = fusedWrChanges + 1; }
    if previous == 0 && next == 1 && fusedWire18 == 0 {
      fusedWrites = fusedWrites + 1;
      if fusedWire17 == 0 { writeCommand(dataBus()); }
      else { writeData(dataBus()); }
    }
  }
  fn fusedLevel(wire: number) -> number {
    return wire == 0 ? (fusedReading ? (fusedReadValue >> 0) & 1 : fusedWire0) :
      wire == 1 ? (fusedReading ? (fusedReadValue >> 1) & 1 : fusedWire1) :
      wire == 2 ? (fusedReading ? (fusedReadValue >> 2) & 1 : fusedWire2) :
      wire == 3 ? (fusedReading ? (fusedReadValue >> 3) & 1 : fusedWire3) :
      wire == 4 ? (fusedReading ? (fusedReadValue >> 4) & 1 : fusedWire4) :
      wire == 5 ? (fusedReading ? (fusedReadValue >> 5) & 1 : fusedWire5) :
      wire == 6 ? (fusedReading ? (fusedReadValue >> 6) & 1 : fusedWire6) :
      wire == 7 ? (fusedReading ? (fusedReadValue >> 7) & 1 : fusedWire7) :
      wire == 8 ? (fusedReading ? (fusedReadValue >> 8) & 1 : fusedWire8) :
      wire == 9 ? (fusedReading ? (fusedReadValue >> 9) & 1 : fusedWire9) :
      wire == 10 ? (fusedReading ? (fusedReadValue >> 10) & 1 : fusedWire10) :
      wire == 11 ? (fusedReading ? (fusedReadValue >> 11) & 1 : fusedWire11) :
      wire == 12 ? (fusedReading ? (fusedReadValue >> 12) & 1 : fusedWire12) :
      wire == 13 ? (fusedReading ? (fusedReadValue >> 13) & 1 : fusedWire13) :
      wire == 14 ? (fusedReading ? (fusedReadValue >> 14) & 1 : fusedWire14) :
      wire == 15 ? (fusedReading ? (fusedReadValue >> 15) & 1 : fusedWire15) :
      wire == 16 ? fusedWire16 : wire == 17 ? fusedWire17 :
      wire == 18 ? fusedWire18 : wire == 19 ? fusedWire19 : -1;
  }

  /**
   * 追加线的实际电平：器件拉低优先于 MCU 意图；按键释放时由板载 10 kΩ 上拉给出 1。
   * PA0/PB0/PB1/PB2 对应 B4/B1/B2/B3（id 4/1/2/3）。
   */
  fn fusedDeviceLevel(wire: number) -> number {
    return wire == 20 ? fusedWire20 :
      wire == 21 ? (button4 ? 0 : (fusedWire21 < 0 ? 1 : fusedWire21)) :
      wire == 22 ? (button1 ? 0 : (fusedWire22 < 0 ? 1 : fusedWire22)) :
      wire == 23 ? (button2 ? 0 : (fusedWire23 < 0 ? 1 : fusedWire23)) :
      wire == 24 ? (button3 ? 0 : (fusedWire24 < 0 ? 1 : fusedWire24)) :
      wire == 25 ? fusedI2cScl() :
      wire == 26 ? fusedI2cSda() :
      wire == 27 ? fusedWire27 :
      wire == 28 ? fusedWire28 :
      wire == 29 ? fusedWire29 :
      wire == 30 ? fusedTimerLevel(TIMER_ID_U8) :
      wire == 31 ? fusedTimerLevel(TIMER_ID_U7) : -1;
  }

  /**
   * 固定板只把三路模拟输入暴露给 ADC：PB12(ADC1_IN11)、PB15(ADC2_IN15)、
   * PB14(ADC1_IN5，§2 MCP4017)。LCD/GPIO/按键等数字节点即使当前电平确定，
   * 也不得被当作“已接 ADC 的稳定模拟电压”；ADC 读到的是浮空/无数据。
   * -2/-3 是内部 VDDA/VREFP 参考。
   */
  fn fusedStatus(wire: number) -> SampleStatus {
    if wire == -2 || wire == -3 { return SampleStatus.valid; }
    if wire == 27 || wire == 29 { return SampleStatus.valid; }
    if wire == 28 { return fusedWiperValid ? SampleStatus.valid : SampleStatus.floating; }
    return SampleStatus.floating;
  }

  fn fusedVoltage(wire: number) -> number {
    if wire == -2 || wire == -3 { return 3.3; }
    if wire == 27 { return 3.3 * pot2; }
    if wire == 29 { return 3.3 * pot1; }
    if wire == 28 { return fusedWiperValid ? fusedWiperVoltage : 0; }
    return 0;
  }

  /** PD2 的任一跳变都捕获当前 D 字节；LE 高时透明由 ledState 直接跟随。 */
  fn fusedLatch(previous: number) {
    const next = fusedWire20;
    if previous != next {
      if next == 1 { ledLatch = ledBits; }
      else if previous == 1 { ledLatch = ledBits; }
    }
  }

  fn applyButton(next: ButtonState) {
    if next.id == 1 {
      if button1 != next.pressed { button1 = next.pressed; button.send(next); }
    } else if next.id == 2 {
      if button2 != next.pressed { button2 = next.pressed; button.send(next); }
    } else if next.id == 3 {
      if button3 != next.pressed { button3 = next.pressed; button.send(next); }
    } else {
      if button4 != next.pressed { button4 = next.pressed; button.send(next); }
    }
  }

  fn applyPotentiometer(next: PotentiometerState) {
    if next.id == 1 {
      if pot1 != next.position { pot1 = next.position; potentiometer.send(next); }
    } else {
      if pot2 != next.position { pot2 = next.position; potentiometer.send(next); }
    }
  }

  process publishLed on ledState {
    led.send(ledState);
  }

  process buttonInputs on buttonReady {
    loop {
      const next = await setButton.receive();
      assert next.id >= 1 && next.id <= 4, "button id must be 1..4";
      applyButton(next);
    }
  }

  process potentiometerInputs on potReady {
    loop {
      const next = await setPotentiometer.receive();
      assert next.id >= 1 && next.id <= 2, "potentiometer id must be 1..2";
      assert isFinite(next.position) && next.position >= 0 && next.position <= 1,
        "potentiometer position must be a finite value within 0..1";
      applyPotentiometer(next);
    }
  }

  fn fusedReadWindow() {
    const active = fusedWire18 == 0 && fusedWire19 == 0;
    if active && !fusedReading { driveData(readValue()); }
    else if !active && fusedReading { releaseData(); }
  }

  /** 外部 NRST 低电平保持 halted；释放沿只复位 MCU，不破坏 LCD 侧独立状态。 */
  reaction nrstRelease on NRST.sample.level as (previous, next) {
    if next == Logic.low {
      halted = true;
    } else if previous == Logic.low && next != Logic.low {
      mcuReset();
    }
  }
/**
 * CT117E-M4 U7/U8 XL555 无稳态定时器（生产 DDL 片段）。
 *
 * 目标 device：Ct117eM4。集成时把本片段放在该 device 体内唯一一份，并在既有
 * `process start` 内调用 `fusedTimerStart();`。不要把 555 状态放进 `mcuReset()`：
 * U7/U8 由 VDD 独立硬连供电，NRST 只复位 MCU。
 *
 * 板级拓扑（已按 PDF 页 1 复核）：
 *   U7: OUT → R39 电位器 → R31 100 Ω → TRIG+THRES/C26 100 nF；RESET=VDD，DISCH 悬空。
 *   U8: OUT → R40 电位器 → R32 100 Ω → TRIG+THRES/C28 100 nF；RESET=VDD，DISCH 悬空。
 *   半周期 t = ln(2) × (100 Ω + position × 10 kΩ) × 100 nF；输出推挽、占空比约 50 %。
 *   U7 OUT → J9 → PB4 (TIM3_CH1)；U8 OUT → J10 → PA15 (TIM2_CH1)。
 *
 * 调度合同：
 * - 正常边沿用 `await ticks(deadline - now())`，不做固定巡检。每个 phase 的 deadline 都从
 *   epoch 与半周期实数一次取整，避免逐半周期累积误差。
 * - DDL 没有可取消的定时等待，也不能用 input channel 提前唤醒 ticks 等待。因此改电位器
 *   只更新已应用 position 与公共事件；当前已经等待的边沿仍按旧 deadline 发生，下一段
 *   （从该边沿起）改用新 position 重新锚定 epoch/phase。频率切换最多延迟一个旧半周期，
 *   之后仍是绝对相位网格；不会出现旧周期被重复累积或提前覆盖 PC。
 * - FIFO 满沿用 standalone producer 的可检测合同：captureOverflow=1、fault(0xffffffff)、
 *   halted=true；振荡器继续振荡，但不再入队。不会静默丢边沿。
 * - `timerEdge` 只是观测通道；容量 4096，同一 sync 批次内超过 4096 条时只丢最老的
 *   观测事件（Overflow.drop_oldest），不影响输出电平、FIFO 或调度。
 */

  /** U7 / R39 / PB4（TIM3_CH1）。 */
  const TIMER_ID_U7 = 1;
  /** U8 / R40 / PA15（TIM2_CH1）。 */
  const TIMER_ID_U8 = 2;
  /** 与 fusion.ts 的 FUSED_WIRES 追加顺序一致：PA15=30、PB4=31。 */
  const FUSED_TIMER_WIRE_U7 = 31;
  const FUSED_TIMER_WIRE_U8 = 30;
  /** standalone capture producer 约定：0=PA15，1=PB4。 */
  const FUSED_TIMER_CAPTURE_PIN_U7 = 1;
  const FUSED_TIMER_CAPTURE_PIN_U8 = 0;
  const FUSED_TIMER_BASE_RESISTANCE = 100;
  const FUSED_TIMER_POT_RESISTANCE = 10_000;
  const FUSED_TIMER_CAPACITANCE = 100e-9;
  const FUSED_TIMER_LN2 = 0.6931471805599453;

  record TimerPotRequest {
    id: number;
    position: number;
  }
  record TimerPotState {
    id: number;
    position: number;
  }
  record TimerEdgeEvent {
    time: number;
    level: bool;
    id: number;
  }

  input channel setTimerPotentiometer: TimerPotRequest(capacity: 8, overflow: Overflow.error);
  output channel timerPotentiometer: TimerPotState(capacity: 16, overflow: Overflow.drop_oldest);
  output channel timerEdge: TimerEdgeEvent(capacity: 4096, overflow: Overflow.drop_oldest);

  state fusedTimerPosition1: number = 0.5;
  state fusedTimerPosition2: number = 0.5;
  state fusedTimerSegmentPosition1: number = 0.5;
  state fusedTimerSegmentPosition2: number = 0.5;
  state fusedTimerOut1: number = 1;
  state fusedTimerOut2: number = 1;
  state fusedTimerEpoch1: number = 0;
  state fusedTimerEpoch2: number = 0;
  state fusedTimerPhase1: number = 0;
  state fusedTimerPhase2: number = 0;
  state fusedTimerDeadline1: number = 0;
  state fusedTimerDeadline2: number = 0;
  state fusedTimerRunning1: bool = false;
  state fusedTimerRunning2: bool = false;
  state fusedTimerControlArmed: bool = false;

  pure fn fusedTimerResistance(position: number) -> number {
    return FUSED_TIMER_BASE_RESISTANCE + position * FUSED_TIMER_POT_RESISTANCE;
  }

  /** 理想半周期（实数 ps）；deadline 才取整。 */
  pure fn fusedTimerHalfPeriodPs(position: number) -> number {
    return FUSED_TIMER_LN2 * fusedTimerResistance(position) * FUSED_TIMER_CAPACITANCE * 1e12;
  }

  /** 推挽输入；id=1 → U7/PB4，id=2 → U8/PA15。非法 id 返回 -1，仅作防御。 */
  pure fn fusedTimerLevel(id: number) -> number {
    return id == TIMER_ID_U7 ? fusedTimerOut1 : id == TIMER_ID_U8 ? fusedTimerOut2 : -1;
  }

  fn fusedTimerPublishPot(id: number, position: number) {
    timerPotentiometer.send({ id: id, position: position });
  }

  /**
   * 一条真实边沿的 16 B FIFO 记录：绝对 ps（lo/hi）、pinId、电平字节。
   * 只置 capturePending/serviceMask，不覆盖 pc/captureResume；WFI/WFE 由既有
   * cpuWfiPoll/cpuWfePoll 观察 serviceMask 唤醒。FIFO 满时使用既有 overflow/fault 合同。
   */
  fn fusedTimerPushCapture(pinId: number, high: bool) {
    if captureOverflow != 0 || !captureArmed(pinId) || halted {
      return;
    }
    if captureTail - captureHead >= 64 {
      captureOverflow = 1;
      faultPc = 0xffffffff;
      halted = true;
      fault.send(0xffffffff);
      return;
    }
    const at = (captureTail % 64) * 16;
    const t = now();
    store32le(captureFifo, at, t % 4294967296);
    store32le(captureFifo, at + 4, floor(t / 4294967296));
    store8(captureFifo, at + 8, pinId);
    if high { store8(captureFifo, at + 9, 1); }
    else { store8(captureFifo, at + 9, 0); }
    captureTail = captureTail + 1;
    capturePending = 1;
    serviceMask = serviceMask | 32;
  }

  fn fusedTimerPublishEdge(id: number, high: bool) {
    const pinId = id == TIMER_ID_U7 ? FUSED_TIMER_CAPTURE_PIN_U7 : FUSED_TIMER_CAPTURE_PIN_U8;
    fusedTimerPushCapture(pinId, high);
    timerEdge.send({ time: now(), level: high, id: id });
  }

  /**
   * 完成当前半周期并翻转输出。若 position 在等待期间改变，则把本边沿作为新频率段的
   * 起点：epoch=now、phase=0，从下一段开始使用新 position 的绝对相位。
   */
  fn fusedTimerAdvancePhase(id: number) {
    if id == TIMER_ID_U7 {
      const high = fusedTimerOut1 == 0;
      fusedTimerOut1 = high ? 1 : 0;
      fusedTimerPublishEdge(id, high);
      if fusedTimerPosition1 != fusedTimerSegmentPosition1 {
        fusedTimerSegmentPosition1 = fusedTimerPosition1;
        fusedTimerEpoch1 = now();
        fusedTimerPhase1 = 0;
      } else {
        fusedTimerPhase1 = fusedTimerPhase1 + 1;
      }
      fusedTimerDeadline1 = round(
        fusedTimerEpoch1 + (fusedTimerPhase1 + 1) * fusedTimerHalfPeriodPs(fusedTimerSegmentPosition1)
      );
    } else {
      const high = fusedTimerOut2 == 0;
      fusedTimerOut2 = high ? 1 : 0;
      fusedTimerPublishEdge(id, high);
      if fusedTimerPosition2 != fusedTimerSegmentPosition2 {
        fusedTimerSegmentPosition2 = fusedTimerPosition2;
        fusedTimerEpoch2 = now();
        fusedTimerPhase2 = 0;
      } else {
        fusedTimerPhase2 = fusedTimerPhase2 + 1;
      }
      fusedTimerDeadline2 = round(
        fusedTimerEpoch2 + (fusedTimerPhase2 + 1) * fusedTimerHalfPeriodPs(fusedTimerSegmentPosition2)
      );
    }
  }

  fn fusedTimerSetPosition(id: number, position: number) {
    assert id == TIMER_ID_U7 || id == TIMER_ID_U8,
      "timer id must be 1 (U7/R39/PB4) or 2 (U8/R40/PA15)";
    assert isFinite(position) && position >= 0 && position <= 1,
      "timer potentiometer position must be a finite value within 0..1";
    if id == TIMER_ID_U7 {
      if position == fusedTimerPosition1 { return; }
      fusedTimerPosition1 = position;
      fusedTimerPublishPot(id, position);
    } else {
      if position == fusedTimerPosition2 { return; }
      fusedTimerPosition2 = position;
      fusedTimerPublishPot(id, position);
    }
  }

  /**
   * 初始化两个振荡器。由既有 `process start` 末尾调用。上电输出高（电容低于 1/3 VCC），
   * 不发送 t=0 的伪边沿；第一个事件是半个周期后的下降沿。
   */
  fn fusedTimerStart() {
    if fusedTimerControlArmed { return; }
    fusedTimerPosition1 = 0.5;
    fusedTimerPosition2 = 0.5;
    fusedTimerSegmentPosition1 = 0.5;
    fusedTimerSegmentPosition2 = 0.5;
    fusedTimerOut1 = 1;
    fusedTimerOut2 = 1;
    fusedTimerEpoch1 = now();
    fusedTimerEpoch2 = now();
    fusedTimerPhase1 = 0;
    fusedTimerPhase2 = 0;
    fusedTimerDeadline1 = round(
      fusedTimerEpoch1 + fusedTimerHalfPeriodPs(fusedTimerSegmentPosition1)
    );
    fusedTimerDeadline2 = round(
      fusedTimerEpoch2 + fusedTimerHalfPeriodPs(fusedTimerSegmentPosition2)
    );
    fusedTimerPublishPot(TIMER_ID_U7, fusedTimerPosition1);
    fusedTimerPublishPot(TIMER_ID_U8, fusedTimerPosition2);
    fusedTimerRunning1 = true;
    fusedTimerRunning2 = true;
    fusedTimerControlArmed = true;
  }

  process fusedTimerOscillate1 on fusedTimerRunning1 {
    loop {
      if !fusedTimerRunning1 { return; }
      const remaining = fusedTimerDeadline1 - now();
      if remaining > 0 {
        await ticks(remaining);
        if !fusedTimerRunning1 { return; }
        if now() < fusedTimerDeadline1 { continue; }
      }
      fusedTimerAdvancePhase(TIMER_ID_U7);
    }
  }

  process fusedTimerOscillate2 on fusedTimerRunning2 {
    loop {
      if !fusedTimerRunning2 { return; }
      const remaining = fusedTimerDeadline2 - now();
      if remaining > 0 {
        await ticks(remaining);
        if !fusedTimerRunning2 { return; }
        if now() < fusedTimerDeadline2 { continue; }
      }
      fusedTimerAdvancePhase(TIMER_ID_U8);
    }
  }

  process fusedTimerControl on fusedTimerControlArmed {
    loop {
      const request = await setTimerPotentiometer.receive();
      fusedTimerSetPosition(request.id, request.position);
    }
  }
}
