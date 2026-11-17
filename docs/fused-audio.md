# 融合编辑器音频

状态：已在本地实现，尚未关联实现 PR。二维上下文合同见 [RFC 0022](./rfc/0022-device-2d-presentation.md)。

融合编辑器的 2D 实例上下文提供 `context.audio`，使用 [RFC 0016](./rfc/0016-widget-audio-api.md) 的振荡器、PCM 格式、缓冲上限和整块接纳语义。每个实例独立持有句柄；隐藏画面或关闭 HTML 面板不会释放音频。

宿主通过 `createWorkbench({ audio: { context } })` 或 `createFusedRuntime({ audio: { context } })` 配置调用方持有的 `AudioContext`。省略配置时状态为 `unavailable`，句柄仍可使用，PCM 写入返回 `false`。可选配置包括 `destination`、`getAudioWorklet` 和每实例 `limits`。

```ts
const context = new AudioContext();
// 在用户点击处理函数中直接调用；浏览器挂起时运行仿真不会自动解除限制。
runButton.onclick = () => {
  void context.resume().catch(reportError);
  void runtime.resume().catch(reportError);
};
```

宿主负责关闭自己创建的 `AudioContext`。编辑器只释放自己的节点、端口和订阅。浏览器挂起、仿真暂停期间状态为 `suspended`；恢复后为 `running`。暂停冻结 PCM 消费并保留缓冲，重置、切换模式和销毁撤销旧实例会话并清空所有声音。仿真步进不等待音频播放或缓冲可用。

```ts
const tone = context.audio.tone({ frequency: 660, volume: 0 });
tone.set({ frequency: 880, volume: 0.1 }, { rampMs: 5 });
tone.stop();

const stream = context.audio.createStream({
  sampleRate: 22050,
  channels: 1,
  format: 's16',
  bufferMs: 300,
});
const accepted = await stream.write(samples);
// false 表示整块拒绝；不要用音频写入结果控制仿真时钟。
stream.end();
```

`onDidChangeState`、流的 `onDidChangeStatus` 和 `onDidDrain` 为 core `Event`，返回 `Disposable`。句柄 `ended` 在实例释放时以 `disposed` 完成。`audio-failed`、`audio-limit` 诊断由宿主以 `audio/failed`、`audio/limit` 上报；加载失败后本次运行音频不可用。

运行时的 `runtime.audio` 提供 `setMuted`、`setInstanceVolume`、`suspend` 和 `resume`。冻结音频不会挂起调用方的整个 `AudioContext`。振荡器和 PCM 经独立 RPC 端口直达宿主拥有的 AudioWorklet；PCM 复制调用视图并转移副本，调用方保留原始缓冲。

工作台在宿主文档上捕获真实指针与键盘交互，在用户手势内调用 `AudioContext.resume()` 自动解锁声音；上下文再次挂起时，后续交互会重试。销毁工作台时移除监听，调用失败通过 `audio/failed` 诊断上报。直接使用 `createFusedRuntime` 的宿主自行处理解锁。

工作台示例：运行 `pnpm --filter @mica-js/playground dev:workbench`，打开 `/workbench.html`，点击“运行”并按住 S1。开关的实例上下文在按住期间输出 660 Hz 音调，释放后静音。
