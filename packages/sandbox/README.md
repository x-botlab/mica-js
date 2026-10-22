# @mica-js/sandbox

在**相对隔离**的环境中运行不可信的第三方 JavaScript（仿真器内核、2D Widget 等）。

```text
宿主页面
 └── iframe  sandbox="allow-scripts"      ← 不透明源（opaque origin）
      └── Web Worker（classic）           ← 不透明源
           └── 客户代码
```

- 宿主与 Worker 通过握手阶段建立的 `MessagePort` **直连通信**，iframe 只负责创建 Worker。
- 客户代码没有 DOM、cookie、localStorage、IndexedDB 与网络；死循环不阻塞宿主 UI，可被强制终止。
- 渲染走「客户离屏渲染 + 宿主合成」：客户在 Worker 内画 `OffscreenCanvas`，每帧把 `ImageBitmap` 零拷贝交回宿主。

## 安装

```bash
pnpm add @mica-js/sandbox
```

## 快速上手

```ts
import { createSandbox } from '@mica-js/sandbox';

const sandbox = await createSandbox({
  name: 'gauge',
  source: {
    type: 'module',
    code: `
      export function setup(ctx) {
        return {
          add: (a, b) => a + b,
          title: () => ctx.invoke('pageTitle'),
        };
      }
    `,
  },
  capabilities: { pageTitle: () => document.title },
  onLog: (entry) => console.log('[sandbox]', entry.level, ...entry.parts),
});

await sandbox.call('add', 1, 2); // 3
await sandbox.terminate(); // 组件卸载/页面卸载时务必调用
```

## 宿主页面要求

**无 CSP 的页面开箱即用**。沙箱支持两种帧加载模式：

| 模式             | 机制                             | 宿主需要做什么                   |
| ---------------- | -------------------------------- | -------------------------------- |
| 默认（`srcdoc`） | 库生成帧文档写入 `iframe.srcdoc` | 无 CSP 时无需配置；有 CSP 时见下 |
| `frameUrl`       | 帧文档由宿主托管                 | 只需 `frame-src` 放行该 URL      |

### 默认模式的 CSP

`about:srcdoc` 文档**继承宿主 CSP**，且只能收紧不能放宽。宿主需放行：

```text
script-src 'self' 'unsafe-inline' blob: 'unsafe-eval';   # 或 'nonce-<宿主 nonce>' blob: 'unsafe-eval'
worker-src blob:;
```

- **内联脚本**：`'unsafe-inline'`，或把站点 nonce 传给 `nonce` 选项（默认自动探测页面已有的 `script[nonce]`）；哈希方案不可行（bootstrap 含随机内容）。
- **`blob:`**：Worker 脚本与客户 ESM 模块都以 blob 加载；缺少时表现为「Worker 创建成功但没有任何响应」。
- **`'unsafe-eval'`**：仅当客户代码（如 Emscripten 产物）需要 `eval`/`new Function`；真正的边界是不透明源 + 断网 + 无宿主 DOM。
- **`worker-src blob:`**：缺少时 Worker 直接创建失败。
- `frame-src` 不需要为 `about:srcdoc` 额外放行。
- 启用 `require-trusted-types-for 'script'` 时，库会自动创建并复用 `mica-sandbox` 策略；页面 `trusted-types` 指令需允许该策略名，或用 `trustedTypesPolicy` 传入自建策略。

### 严格 CSP：用 `frameUrl`

从真实 URL 加载的帧文档**不继承**宿主 CSP，只需 `frame-src 'self';`。宿主可用 `SANDBOX_FRAME_HTML` 动态返回该文档（或自行托管同一内容）：

```ts
import { SANDBOX_FRAME_HTML } from '@mica-js/sandbox';

app.get('/mica-sandbox-frame.html', (_req, res) => {
  res
    .type('text/html')
    .set(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline' blob: 'unsafe-eval'; worker-src blob:; frame-ancestors 'self'",
    )
    .send(SANDBOX_FRAME_HTML);
});

const sandbox = await createSandbox({ frameUrl: '/mica-sandbox-frame.html', source });
```

### 其他要求

- 仅浏览器可用。Node/SSR 中 `import` 安全，调用 `createSandbox` 抛 `SandboxError('unsupported-environment')`。
- 宿主页面本身不能位于未授予 `allow-scripts` 的 sandbox iframe 中。
- 每个沙箱创建 1 个隐藏 iframe + 1 个 Worker；大量实例时应在业务侧复用或排队。

## API

### `createSandbox(options)`

| 选项                            | 说明                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `source`                        | 客户代码：`{ type: 'module', code \| url }` 或 `{ type: 'script', code \| url, globalName? }`；`url` 由**宿主** fetch 后内联（客户无网络） |
| `capabilities`                  | 客户可调用的宿主函数表，见下                                                                                                               |
| `name`                          | 诊断名称，回显在 `sandbox.info.name`                                                                                                       |
| `container` / `hidden`          | 隐藏 iframe 的挂载点与可见性（调试时可设为可见）                                                                                           |
| `bootTimeoutMs`                 | 握手预算，默认 `10_000`                                                                                                                    |
| `callTimeoutMs`                 | `call`/`request` 默认超时，`0` 表示不超时                                                                                                  |
| `onCallTimeout`                 | 超时后 `'reject'`（默认）或 `'terminate'`                                                                                                  |
| `frameUrl`                      | 使用宿主托管帧文档（严格 CSP 推荐）                                                                                                        |
| `nonce`                         | 复用宿主 CSP nonce（默认自动探测）                                                                                                         |
| `trustedTypesPolicy`            | 自定义 Trusted Types 策略                                                                                                                  |
| `csp`                           | 覆盖帧文档策略：字符串或 `(defaultCsp) => csp`                                                                                             |
| `canvas` / `onFrame` / `maxFps` | 帧合成，见「离屏 Canvas」                                                                                                                  |
| `captureConsole`                | 接管客户 `console.*` 并转发，默认 `true`                                                                                                   |
| `onLog`                         | 接收 `{ level, parts, timestamp }`                                                                                                         |

### `SandboxHandle`

```ts
sandbox.call('render', { value: 0.5 }); // 类型化调用（配合泛型）
sandbox.request('render', [payload], { transfer: [buffer], timeoutMs: 500 });
sandbox.notify('reset'); // 单向，不等待结果
sandbox.emit('tick', { dt: 16 }); // 宿主 → 客户事件
sandbox.on('frameDone', (payload) => {}); // 客户 → 宿主事件
sandbox.resize({ width: 480, height: 220, dpr: 2 });
await sandbox.terminate('unmounted'); // 幂等
```

`sandbox.info` 提供 `origin`（不透明源下为 `'null'`）、`guestMethods`、`features`（wasm / offscreenCanvas / webgl2）。

### capability

`capabilities` 是**宿主代客户执行的能力白名单**，运行在宿主主线程，可访问 DOM/Canvas/网络：

```ts
const sandbox = await createSandbox({
  source,
  capabilities: {
    draw: (commands) => {
      /* 来自不可信客户：照常校验参数 */
    },
    loadWasm: async () => transferable(await (await fetch('/vendor/x.wasm')).arrayBuffer()),
  },
});
```

- 参数与返回值必须可结构化克隆；`transferable(value, list)` 让 `ArrayBuffer` 零拷贝传给客户。
- 抛错会序列化 `name`/`message`/`stack` 回传客户（`ctx.invoke` 因此 reject）。
- 调用未注册的名字 → `SandboxError('capability-not-found')`。

### 客户侧契约

```js
export function setup(ctx) {
  ctx.handle('render', (payload) => ({ ok: true }));

  // 也可直接返回方法表
  return {
    render(payload) {
      ctx.invoke('draw', [{ x: 0, y: 0, w: 10, h: 4, color: '#0af' }]);
      ctx.emit('frameDone', { at: Date.now() });
      return { ok: true };
    },
  };
}

export function dispose() {
  /* 终止前清理 */
}
```

`ctx` 提供：`id`、`name`、`signal`（终止时 abort）、`handle`、`invoke` / `invokeWith`、`on` / `off` / `emit`、`log`、`createSurface`。

classic script（如 Emscripten 产物）只需挂载全局入口：

```js
self.MicaGuest = {
  setup(ctx) {
    return { run: () => 'ok' };
  },
};
```

## 离屏 Canvas

```ts
const canvas = document.querySelector('canvas');
const sandbox = await createSandbox({ source, canvas, maxFps: 60 });
new ResizeObserver(([entry]) => {
  const { width, height } = entry.contentRect;
  sandbox.resize({ width, height, dpr: devicePixelRatio });
}).observe(canvas);
```

```js
export function setup(ctx) {
  const surface = ctx.createSurface(); // 尺寸/DPR 跟随宿主
  const g = surface.canvas.getContext('2d');
  ctx.on('tick', () => {
    g.clearRect(0, 0, surface.width, surface.height);
    g.fillRect(0, 0, surface.width * 0.5, 8);
    surface.commit(); // transferToImageBitmap → 宿主合成
  });
}
```

- WebGL2：`surface.canvas.getContext('webgl2', { preserveDrawingBuffer: true })`，帧末 `commit()`。
- `commit()` 会清空画布（`transferToImageBitmap` 语义），每帧需重绘；宿主侧 `maxFps`（默认 60）对合成限流，超出直接丢弃并 `close()`。
- **限制**：不能把 `canvas.transferControlToOffscreen()` 结果转移进沙箱（实测 Chrome 会崩溃渲染进程），可见 canvas 始终留在宿主。
- 不传 `canvas` 时可用 `onFrame(bitmap, geometry)` 自行合成（此时由调用方 `bitmap.close()`）。

## 定时器与帧调度

沙箱**不修改 Worker 的全局环境**，标准异步 API 原样可用（Chromium 155 实测）：

| API                                                                       | 结果                                                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval`           | ✅ 正常，实测 `setTimeout(50)` 约 56ms、`setInterval(10)×5` 约 76ms、`clearTimeout` 生效 |
| `queueMicrotask` / `Promise` / `async-await`                              | ✅                                                                                       |
| `performance.now` / `Date.now`                                            | ✅                                                                                       |
| `structuredClone` / `MessageChannel` / `AbortController`                  | ✅                                                                                       |
| `Blob` / `URL.createObjectURL` / `crypto.getRandomValues` / `TextEncoder` | ✅                                                                                       |
| `WebAssembly` / `importScripts` / `eval` / `new Function`                 | ✅（wasm 字节需宿主经 capability 传入）                                                  |
| `fetch` / `XHR`                                                           | ❌ 函数存在但被 `connect-src 'none'` 阻断                                                |
| `indexedDB` / `localStorage`                                              | ❌ 不透明源：`open()` 抛 `SecurityError`，`localStorage` 不存在                          |
| `document`                                                                | ❌ 不存在                                                                                |

三点注意：

1. **定时器跑在 Worker 线程里**：客户执行长同步任务（死循环、大块计算）期间不会触发，没有抢占。需要精确节奏时由宿主 `emit('tick', { dt })` 驱动。
2. **`requestAnimationFrame` 不可移植**：当前 Chromium 的 Worker 里有，但不是规范保证。跨浏览器请写成 `typeof self.requestAnimationFrame === 'function' ? rAF : setTimeout`，或直接用宿主 tick。
3. **标签页切到后台时**浏览器可能节流定时器（页面级行为）；仿真器应按虚拟时间推进，而不是依赖墙钟。

## 错误与生命周期

```ts
import { SandboxError } from '@mica-js/sandbox';

try {
  await sandbox.call('step', 1_000_000);
} catch (error) {
  if (error instanceof SandboxError) {
    switch (error.code) {
      case 'timeout': // 客户可能卡死，建议 terminate 后重建
      case 'terminated':
      case 'capability-failed':
      case 'boot-failed':
      default:
        break;
    }
  }
}
```

- 超时只拒绝当前调用；`onCallTimeout: 'terminate'` 可自动回收卡死的 Worker。
- `terminate()` 幂等：拒绝进行中的调用 → 通知客户 `dispose` → 终止 Worker → 移除 iframe。
- 客户未捕获异常与未处理的 Promise rejection 以 `error` 事件回传。

## 安全边界

**保证**

- 客户无法访问宿主 DOM、cookie、localStorage、IndexedDB、同源接口。
- 客户没有网络能力，资源需由宿主经 capability 传入。
- 死循环只影响 Worker 线程，宿主 UI 不受影响且可强制终止。
- 客户无法调用未在 `capabilities` 中声明的宿主函数。

**不保证**

- 不是进程级隔离（与宿主共享浏览器进程/沙箱），存在侧信道与浏览器漏洞风险；不要用它运行真正恶意的对手代码。
- 没有 CPU/内存配额；可用 `callTimeoutMs` + `onCallTimeout: 'terminate'` 兜底。
- 不防御渲染层面滥用：客户可持续提交高分辨率帧，宿主用 `maxFps` 限流。

**已知限制**

- 不支持 module 类型 Worker（不透明源 iframe 中创建 blob module worker 会失败），客户 ESM 代码通过 classic Worker 内 `import(blobUrl)` 加载。
- 不支持 `SharedArrayBuffer`（需要跨源隔离），大块数据请用 transferable。
- `{ type: 'url' }` 的客户模块内部相对导入无法解析（代码被内联执行，没有 URL 基准）。

## 开发

```bash
pnpm --filter @mica-js/sandbox build      # 构建（内联 Worker 运行时 + 生成 sandbox-frame.html）
pnpm --filter @mica-js/sandbox test       # Node 单测
pnpm --filter @mica-js/sandbox typecheck
pnpm --filter @mica-js/sandbox-playground dev   # 浏览器手测面板
```

`apps/sandbox-playground` 覆盖基础调用、capability、离屏 2D/WebGL、事件日志、错误、超时终止、隔离自检、classic script，以及 `inline` / `url` 两种模式切换。
