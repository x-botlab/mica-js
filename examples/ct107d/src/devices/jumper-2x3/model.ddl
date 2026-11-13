/**
 * 2×3 跳线排针（CT107D 板位 J2：红外收发选择）。
 *
 * 引脚与原理图一致：左列 1/3/5、右列 2/4/6。
 *
 * - 1-3 固定短接：MCU `P1.0`（网络 `P10`）经 U18 整形/驱动链到红外发射管；
 * - 接收端公共脚为 4（网络 `P11`）：`vs1838` 为 true 时短接 4-6（VS1838 输出 `N_B2`），
 *   false 时短接 2-4（CX20106A 输出 `N_B1`）。
 *
 * 引脚 5 是红外发射管支路（`N_A2`），板上不插跳线帽时悬空，模型同样只保留为未连接引脚。
 *
 * 理想化：跳线帽是装配期配置，没有插拔过程、接触电阻漂移，也不检查同一列插多个帽的冲突。
 */
device JumperHeader2x3(
  vs1838: bool default true,
  resistance: number default 0.05
) {
  assert isFinite(resistance) && resistance >= 0.001 && resistance <= 1_000_000,
    "resistance must be a finite ohm value within 0.001..1000000";

  /** 左列 1：发送通路，固定短接到 3。 */
  pin p1 = [resistor(to: p3, resistance: resistance)];
  /** 右列 2：CX20106A 输出（`N_B1`）。 */
  pin p2;
  /** 左列 3：MCU `P1.0`（`P10`）。 */
  pin p3;
  /** 右列 4：MCU `P1.1`（`P11`），接收端公共脚。 */
  pin p4;
  /** 左列 5：红外发射管支路（`N_A2`）。 */
  pin p5;
  /** 右列 6：VS1838 输出（`N_B2`）。 */
  pin p6;

  process start {
    if vs1838 {
      p4.intent <- [resistor(to: p6, resistance: resistance)];
    } else {
      p4.intent <- [resistor(to: p2, resistance: resistance)];
    }
  }
}
