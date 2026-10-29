# Widget 音频 API

- Start Date: 2026-10-23
- Reference Issues: [#133](https://github.com/x-botlab/mica-js/issues/133)
- Implementation PR: —（尚未实现）

在 [Widget JavaScript API](./0015-widget-js-api.md) 之上增加实例级音频能力 `api.audio`：持续振荡器与 PCM 流。Widget 只提交参数与样本；振荡器合成、PCM 缓冲、重采样、混音与音量全部由音频渲染线程完成，与「guest 离屏绘制 + 宿主合成」的画面模型对称。

音频能力不需要在 [Widget 定义](./0014-widget-definition.md)中声明，可用性只由宿主配置决定。

## 声明

### 上下文接口

```ts
interface WidgetAudioApi {
  readonly state: WidgetAudioState;
  onStateChange(listener: (state: WidgetAudioState) => void): () => void;
  tone(options: WidgetAudioToneOptions): WidgetAudioTone;
  createStream(options: WidgetAudioStreamOptions): WidgetAudioStream;
}

type WidgetAudioState = 'unavailable' | 'suspended' | 'running';

type WidgetAudioEndReason =
  'finished' | 'stopped' | 'dropped' | 'error' | 'unavailable' | 'disposed';
```

`tone` 与 `createStream` 同步返回句柄，句柄 ID 由 guest 分配；参数非法属于实现错误，同步抛出。运行期结果（配额、缓冲不足、设备错误）异步体现在句柄状态、`ended` 与诊断中。

### 振荡器

```ts
interface WidgetAudioToneOptions {
  /** `sine` when omitted. */
  readonly type?: 'sine' | 'square' | 'triangle' | 'sawtooth';
  /** Hz, `(0, 24000]`. */
  readonly frequency: number;
  /** `0`–`1`; `1` when omitted. */
  readonly volume?: number;
}

interface WidgetAudioTone {
  readonly id: string;
  readonly ended: Promise<{ readonly reason: WidgetAudioEndReason }>;
  set(
    settings: { readonly volume?: number; readonly frequency?: number },
    options?: { readonly rampMs?: number },
  ): void;
  stop(options?: { readonly fadeMs?: number }): void;
}
```

振荡器持续存在直到 `stop()` 或实例卸载；音量为 `0` 时仍占用声部配额。`set()` 按调用顺序生效；方波、锯齿等波形由音频渲染线程带限合成，无混叠、无接缝，`rampMs: 0` 也施加不可感知的最小平滑以避免爆音。

### PCM 流

```ts
interface WidgetAudioStreamOptions {
  /** Integer source rate in Hz, `8000`–`96000`; required. */
  readonly sampleRate: number;
  /** `1` (default) or `2`; multi-channel samples are interleaved. */
  readonly channels?: 1 | 2;
  /** `f32` (default) or `s16`. */
  readonly format?: 's16' | 'f32';
  /** Buffer window in milliseconds, `50`–`2000`; `500` when omitted. */
  readonly bufferMs?: number;
  /** Frames buffered before (re)starting playback, not more than `bufferMs`. */
  readonly startMs?: number;
  /** `0`–`1`; `1` when omitted. */
  readonly volume?: number;
}

interface WidgetAudioStream {
  readonly id: string;
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly format: 's16' | 'f32';
  readonly capacityFrames: number;
  readonly startFrames: number;
  readonly volume: number;
  readonly bufferedFrames: number;
  readonly underruns: number;
  readonly dropped: number;
  readonly state: WidgetAudioStreamState;
  readonly ended: Promise<{ readonly reason: WidgetAudioEndReason }>;
  write(samples: Int16Array | Float32Array): Promise<boolean>;
  clear(): void;
  end(): void;
  close(): void;
  onDrain(listener: () => void): () => void;
  onStatus(listener: (status: WidgetAudioStreamStatus) => void): () => void;
}

type WidgetAudioStreamState = 'buffering' | 'playing' | 'ended' | 'closed';

interface WidgetAudioStreamStatus {
  readonly state: WidgetAudioStreamState;
  readonly underruns: number;
  readonly dropped: number;
  readonly bufferedFrames: number;
  readonly capacityFrames: number;
}
```

`capacityFrames = ceil(bufferMs × sampleRate / 1000)`，`startFrames` 同理；一帧为一个采样时刻的全部声道样本。

| 状态        | 含义                         |
| ----------- | ---------------------------- |
| `buffering` | 已缓冲帧数不足 `startFrames` |
| `playing`   | 正在输出                     |
| `ended`     | `end()` 已播完缓冲           |
| `closed`    | 被 `close()` 或配额终止      |

### 宿主接口

```ts
interface WidgetHostOptions {
  readonly audio?: {
    readonly context: AudioContext;
    readonly destination?: AudioNode;
    readonly getAudioWorklet?: (context: AudioContext) => Promise<AudioWorkletNode>;
    readonly limits?: { readonly maxVoices?: number; readonly maxStreams?: number };
  };
}

interface WidgetAudioControls {
  readonly state: WidgetAudioState;
  setMuted(muted: boolean): void;
  setInstanceVolume(instanceId: string, volume: number): void;
  suspend(): void;
  resume(): void;
}
```

`limits` 默认每实例 8 个声部、4 条流；省略 `audio` 时 `api.audio.state` 恒为 `unavailable`。`getAudioWorklet` 接收宿主创建的 `AudioContext` 并返回已加载的 `AudioWorkletNode`；省略时由实现使用内置的 `?audio-worklet` 资源。

## 运行时

### 音频状态

| 状态          | 含义                                                     |
| ------------- | -------------------------------------------------------- |
| `unavailable` | 宿主未配置音频，或环境不支持（非安全上下文、无 worklet） |
| `suspended`   | 宿主音频已配置但未运行（等待用户手势、宿主冻结或被挂起） |
| `running`     | 正在输出                                                 |

- 初值随 `mount` 下发，`api.audio.state` 同步可读；之后的变化按发生顺序通过 `onStateChange` 串行通知。
- `unavailable` 时全部方法仍可调用并返回有效句柄：`write()` 以 `false` 完成，`end()` 立即以 `finished` 结束，`tone` 在本地 `stop()` 时以 `stopped` 结束。
- `suspended` 期间：`tone` 保留参数，恢复后开始发声；PCM 流照常接收数据直至缓冲满，恢复后从缓冲起点播放。

### 数据通路

- guest 只提交指令与样本，发声全部在宿主 `AudioContext` 的音频渲染线程完成。
- PCM 从 widget 运行时直连音频渲染线程的专用端口，不经渲染宿主主线程；端口由宿主在 `mount` 前转交。
- 二进制数据使用 transferable `ArrayBuffer`，不使用 `SharedArrayBuffer` / `Atomics`；背压由音频渲染线程回传的累计消费帧数实现。
- 控制面与状态通知使用统一的 RPC 服务契约；宿主另经音频节点端口下发宿主级控制并接收诊断。

### 写入与流控

- `write(samples)` 接受与 `format` 匹配的类型化数组，长度为声道数的正整数倍，帧数不超过 `capacityFrames`。
- 写入范围是视图覆盖的元素范围；发出前捕获副本，调用方保留原缓冲区所有权。副本的 `ArrayBuffer` 转移到音频渲染线程，全程只有这一次复制。
- 整块接纳或整块丢弃：缓冲不足以容纳整块时返回 `false`，不入队、不截断，`dropped` 加一；返回 `true` 只表示已接纳，不表示已播放。
- 样本按写入顺序连续播放，中间没有隐式间隙；源采样率被重采样到设备采样率，不改变时长与音高。
- `f32` 样本超出 `[-1, 1]` 时钳位，非有限值按 `0` 处理。
- 音频渲染线程维护每条流的累计消费帧数 `consumedFrames`，约每 20 ms 以及状态变化时回传；guest 以已接纳帧数加上在途帧数减去信用得到 `bufferedFrames`，估计值不小于真实缓冲量。
- 音频渲染线程独立执行容量检查：到达时超出容量的数据块整块丢弃，并按实例与类别首次上报 `widget/audio-limit`。
- `clear()` 丢弃尚未播放的数据并保持流打开；`end()` 播完缓冲后以 `finished` 结束；`close()` 立即丢弃并以 `stopped` 结束。三者均幂等。
- `onDrain` 在 `bufferedFrames` 降到 `capacityFrames / 2` 及以下时触发一次，缓冲重新涨过一半后再次生效。

### 生命周期

- 实例卸载时，该实例的声部与流以 `disposed` 结束。
- 宿主 `suspend()` 只冻结 widget 音频：声部静音、流停止消费并保留缓冲；`resume()` 后从保留位置继续。调用方的 `AudioContext` 状态不受影响。
- 音频可用状态跟随 `AudioContext` 自身状态变化，宿主外部挂起或恢复同样映射为 `suspended` / `running`。
- v1 为实时语义：指令到达后尽快执行，PCM 按接纳顺序连续播放，与仿真时间无关。

## 校验

1. 选项对象为非 null、非数组的普通对象；未知字段或显式 `undefined` 抛出 `TypeError`。
2. `volume` 为 `[0, 1]`，`frequency` 为 `(0, 24000]`，`rampMs`、`fadeMs` 为 `[0, 10000]` 的有限数；类型错误抛出 `TypeError`，越界或非有限值抛出 `RangeError`。
3. `type` 只取 `sine`、`square`、`triangle`、`sawtooth`；`format` 只取 `s16`、`f32`；`channels` 只取 `1`、`2`；其他值抛出 `RangeError`。
4. `sampleRate` 为 `8000`–`96000` 的整数，`bufferMs` 为 `[50, 2000]`，`startMs` 为 `[0, bufferMs]`，否则抛出 `RangeError`。
5. `write` 的样本类型与 `format` 不匹配时抛出 `TypeError`；长度为 `0`、不是声道数整数倍或超过 `capacityFrames` 时抛出 `RangeError`。
6. 监听参数必须为函数，否则抛出 `TypeError`。
7. 音频渲染线程对来自 guest 的每条指令重新校验；非法指令丢弃并按实例首次上报 `widget/audio-failed`。

| `code`                | 场景                                                         |
| --------------------- | ------------------------------------------------------------ |
| `widget/audio-failed` | 音频工作线程加载失败、非法指令或音频设备错误；按实例上报     |
| `widget/audio-limit`  | 超出声部或流配额，或丢弃了超出容量的数据块；按实例与类别上报 |

欠载是正常运行现象，只体现在 `underruns` 统计中，不产生诊断。

## 示例

### 蜂鸣器

```javascript
export default function buzzer(api) {
  let on = false;
  const tone = api.audio.tone({ type: 'square', frequency: api.props.frequency, volume: 0 });

  api.subscribe('on', (value) => {
    on = value;
    tone.set({ volume: on ? api.props.volume : 0 }, { rampMs: 5 });
    api.invalidate();
  });
  api.subscribe('frequency', (hz) => tone.set({ frequency: hz }));

  return {};
}
```

### 扬声器：消费器件 PCM 话题

器件端口 `pcm` 为 `bytes`，布局在器件定义中写明：`s16` 小端、单声道、22050 Hz、每条消息约 10 ms。`onDrain` 与 `bufferedFrames` 组合成拉取式写入：缓冲降到一半时补齐 `capacityFrames - bufferedFrames` 帧。

```javascript
export default function speaker(api) {
  const stream = api.audio.createStream({
    sampleRate: 22050,
    channels: 1,
    format: 's16',
    bufferMs: 300,
  });

  api.subscribe('pcm', (bytes) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = new Int16Array(bytes.byteLength >> 1);
    for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true);
    void stream.write(samples); // false 表示缓冲已满，该块被丢弃
  });

  return {};
}
```

## 范围

- `api.audio` 在实例上下文中的位置由 [RFC 0015](./0015-widget-js-api.md) 规定。
- 音频能力不在 [Widget 定义](./0014-widget-definition.md)中声明；可用性只由宿主配置决定。
- 宿主装配、实例生命周期与帧时钟由 [RFC 0018](./0018-canvas-runtime.md) 规定。
- 器件 PCM 话题的载荷类型与布局由 [RFC 0010](./0010-topic-ports.md) 与器件定义规定，音频只消费其字节。
- 麦克风与音频输入、效果器、空间音频、滤波器链以及向 guest 暴露的 Web Audio 节点图属于后续合同。

## 关联

- [RFC 0015](./0015-widget-js-api.md)：实例上下文接口与回调错误通道。
- [RFC 0018](./0018-canvas-runtime.md)：`WidgetHost` 装配与实例生命周期，音频会话跟随实例挂载。
- [RFC 0010](./0010-topic-ports.md)：器件 PCM 话题的 `bytes` 载荷。
