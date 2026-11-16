/**
 * 三脚开关型霍尔传感器（CT107D 的 U21 接口，OUT 接 `N_HALL`）。
 *
 * OUT 是低有效开漏输出：磁场达到 `operatePoint` 时经 `outputResistance` 拉到 GND，
 * 降到 `releasePoint` 及以下时释放，两个阈值之间保持上次状态。高电平必须由外部上拉
 * 提供；没有上拉时释放状态的 OUT 是悬空的。
 *
 * 供电由真实 `vcc`/`gnd` 引脚采样决定：VCC 为高且 GND 为低才认为上电。掉电时释放
 * OUT 并清除内部锁存；重新上电后只有磁场仍达到吸合点才会再次吸合，处于迟滞区间时
 * 保持释放。这样做的代价是上电行为比真实器件更确定，但不会保留掉电前的输出。
 *
 * 理想化：只模拟单极性开关量，不模拟线性输出、磁极方向、磁滞温漂、输出上升/下降
 * 时间、电源电流与负载效应；磁场是无惯性的瞬时值，不是磁通变化率。
 */
device Hall(
  field: number default 0,
  operatePoint: number default 15,
  releasePoint: number default 10,
  outputResistance: number default 25,
  lowThreshold: number default 0.8,
  highThreshold: number default 2.0
) {
  const MAX_FIELD = 1000;

  assert isFinite(field) && field >= 0 && field <= MAX_FIELD,
    "field must be within 0..1000 mT";
  assert isFinite(operatePoint) && operatePoint >= 0 && operatePoint <= MAX_FIELD,
    "operatePoint must be within 0..1000 mT";
  assert isFinite(releasePoint) && releasePoint >= 0 && releasePoint <= MAX_FIELD,
    "releasePoint must be within 0..1000 mT";
  assert operatePoint > releasePoint,
    "operatePoint must be greater than releasePoint";
  assert outputResistance >= 0.001 && outputResistance <= 1_000_000_000,
    "outputResistance must be within the supported range";
  assert lowThreshold >= 0 && lowThreshold <= 5,
    "lowThreshold must be within 0..5 V";
  assert highThreshold > lowThreshold && highThreshold <= 5,
    "highThreshold must be above lowThreshold and within 5 V";

  pin vcc(low: lowThreshold, high: highThreshold);
  pin gnd(low: lowThreshold, high: highThreshold);
  pin out;

  input channel fieldInput: number(capacity: 8, overflow: Overflow.error);
  output channel active: bool(capacity: 8, overflow: Overflow.drop_oldest);

  /** 最近一次接受的磁场，单位 mT。 */
  state fieldMillitesla: number = field;
  /** 传感器内部的开关锁存；上电后才可能为真。 */
  state latched: bool = false;
  /** 已发布给宿主的吸合状态，用于抑制启动阶段的重复事件。 */
  state reportedActive: bool = false;

  pure fn isHigh(level: Logic) -> bool {
    return level == Logic.high;
  }

  pure fn isLow(level: Logic) -> bool {
    return level == Logic.low;
  }

  /** 只有 VCC 确定拉高且 GND 确定拉低时才认为器件获得供电。 */
  derived powered: bool = isHigh(vcc.sample.level) && isLow(gnd.sample.level);
  /** 对外可见的吸合状态；掉电时强制为假。 */
  derived activeState: bool = powered && latched;

  fn driveOutput(enabled: bool) {
    if enabled {
      out.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      out.intent <- [];
    }
  }

  /** 迟滞更新：进入吸合区置位，进入释放区复位，中间保持。 */
  fn updateLatch(value: number) {
    if value >= operatePoint {
      latched = true;
    } else if value <= releasePoint {
      latched = false;
    }
  }

  /** 上电或重新上电时只按吸合点判定，不把掉电前的锁存带回来。 */
  fn restoreLatch() {
    if fieldMillitesla >= operatePoint {
      latched = true;
    } else {
      latched = false;
    }
  }

  process start {
    if powered {
      restoreLatch();
    } else {
      latched = false;
    }
    driveOutput(activeState);
    reportedActive = activeState;
    active.send(activeState);
    // 启动过程同时是该通道的唯一消费者。
    loop {
      const value = await fieldInput.receive();
      assert isFinite(value) && value >= 0 && value <= MAX_FIELD,
        "field must be within 0..1000 mT";
      fieldMillitesla = value;
      if powered {
        updateLatch(value);
      }
    }
  }

  /** 供电变化时释放输出；恢复后按当前磁场重新建立锁存。 */
  process power on powered {
    if powered {
      restoreLatch();
    } else {
      latched = false;
    }
  }

  process changed on activeState {
    driveOutput(activeState);
    if reportedActive != activeState {
      reportedActive = activeState;
      active.send(activeState);
    }
  }
}
