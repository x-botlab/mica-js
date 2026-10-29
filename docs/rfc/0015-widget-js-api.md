# Widget JavaScript API

- Start Date: 2026-10-12
- Reference Issues: [#2](https://github.com/x-botlab/mica-js/issues/2)
- Implementation PR: [#117](https://github.com/x-botlab/mica-js/pull/117)

组件行为由 `*.js` 实现，与同目录、同名的 `*.json` 配对。每个实例通过独立工厂创建并获得实例级上下文：读取属性、维护状态、订阅与发布话题，并在自己的画布上绘制。宿主掌握布局、事件路由、资源权限、调度与位图合成的最终控制权。

属性与端口由 [Widget 定义](./0014-widget-definition.md)拥有，分别引用[属性定义](./0009-device-properties.md)与[话题端口](./0010-topic-ports.md)的规则。

## 模块与实例工厂

组件模块默认导出同步工厂，返回该实例的生命周期与行为回调：

```javascript
export default function createWidget(api) {
  let brightness = 0;

  api.subscribe('brightness', (nextBrightness) => {
    brightness = nextBrightness;
    api.invalidate();
  });

  return {
    render(ctx) {
      const { width, height, props } = api;
      ctx.save();
      ctx.globalAlpha = brightness;
      ctx.fillStyle = props.color;
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, Math.min(width, height) / 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },
  };
}
```

- 一个模块可以创建多个实例，每次工厂调用获得独立上下文；实例状态与订阅保存在工厂作用域。
- 模块顶层用于共享常量与纯函数，工厂作用域提供实例逻辑隔离。
- 插件是安全隔离边界，实例在插件内具有独立的逻辑状态。
- `render` 为可选回调；纯逻辑控制器通过订阅、发布与生命周期回调工作。

## 上下文接口

| 接口                               | 职责                               |
| ---------------------------------- | ---------------------------------- |
| `api.props`                        | 当前完整的只读属性快照             |
| `api.width`、`api.height`          | 当前画布区域的逻辑宽高             |
| `api.invalidate()`                 | 标记需要重绘，由运行时调度绘制     |
| `api.subscribe(port, callback)`    | 订阅逻辑输入端口，返回取消订阅函数 |
| `api.publish(port, payload)`       | 向逻辑输出端口发布载荷             |
| `api.onPropsChanged(callback)`     | 监听属性变化，返回取消监听函数     |
| `api.assets.loadImage(reference)`  | 异步获取可绘制的图片位图           |
| `api.assets.readBinary(reference)` | 异步获取独立二进制缓冲区           |

组件通过逻辑端口名访问通信接口，宿主根据实例绑定完成话题路由与权限检查。

## 属性

`api.props` 是宿主校验后的完整只读属性快照，包含已解析的默认值；属性更新由宿主提交。

```javascript
api.onPropsChanged(({ props, previous, changedKeys }) => {
  if (changedKeys.includes('inertia')) {
    // 下一次模拟使用新惯量，当前角度保持原值。
  }
});
```

属性提交后 `api.props` 先更新，再按提交顺序串行通知监听器，并自动标记重绘。初值通过 `api.props` 读取，状态延续由组件自身维护。

## 话题载荷

```javascript
let torque = 0;

const unsubscribe = api.subscribe('torque', (nextTorque) => {
  torque = nextTorque;
});

api.publish('angle', torque);
unsubscribe();
```

载荷类型取自[话题端口](./0010-topic-ports.md)的封闭清单：`boolean`、`number`、`string`、`vec2d`、`vec3d`、`bytes`、`bytes<rgb565>`、`bytes<segments>`。

`bytes` 及带标签的 `bytes<...>` 统一使用 `Uint8Array`：

- 发布范围是 `Uint8Array` 视图覆盖的字节范围。
- `publish` 在返回前捕获字节副本，消息持有该时刻的字节内容；调用方保留原缓冲区的所有权。
- 每个订阅者获得独立副本，宿主与各订阅者分别持有自己的消息数据。
- 内容格式、大小端与业务解码由通信双方约定。
- 宿主限制单条消息大小、发送频率与队列总字节数。

```javascript
const packet = new Uint8Array([0x01, 0x02, 0xff]);
api.publish('packet', packet);
```

通信规则：

- 输入与输出方向必须与声明一致；未知端口与类型错误属于实现错误。
- 绑定可选；已绑定端口参与投递，空绑定保持静默。
- 缺失输入使用独立状态，与 `0`、`false` 与空字符串分别表达。
- 同一输入端口允许多个监听器；每次取消只移除对应监听器。
- 回调在工厂初始化完成后才可能执行，避免初始化重入。
- 消息校验、新鲜度与话题在线状态分别表达。
- `publish` 表示向宿主提交消息，接收方处理进度与交付保证由通信合同表达；数值发布与状态更新各自独立执行。
- 宿主负责限流与队列上限，组件应控制发布频率。

`meta` 是宿主提供的通信元数据，业务载荷单独传递。每条消息固定携带 `simTime`，即宿主投递时填充的仿真时间（口径见[虚拟时间](./0001-virtual-time.md)）；元数据还包含接收时间与序号。

## 绘制与尺寸

```javascript
return {
  render(ctx) {
    ctx.fillStyle = api.props.color;
    ctx.fillRect(0, 0, api.width, api.height);
  },

  onResize({ width, height }) {
    // 仅在需要重新生成尺寸相关资源时处理。
  },
};
```

- 尺寸与事件坐标均使用逻辑像素；像素密度与缓冲区尺寸由运行时处理。
- 调用 `onResize` 前先更新宽高，之后自动标记重绘；初始有效尺寸也触发尺寸通知。
- 运行时绘制前清空画布、设置逻辑坐标变换并隔离绘制上下文状态。
- `render` 是同步回调；异步资源准备完成后再请求重绘。
- 运行时负责宿主合成位图的创建、传输、确认与释放，最多保留一个在途帧，替换帧时释放旧位图。
- 多次 `invalidate` 合并处理，尺寸或状态变化触发绘制。

## 交互

| 回调             | 含义                       |
| ---------------- | -------------------------- |
| `onClick(event)` | 完成一次有效点击           |
| `onDrag(event)`  | 拖动开始、移动、结束或取消 |
| `onEvent(event)` | 键盘、焦点等其他输入事件   |

`onDrag` 参数包含 `phase`（`start`、`move`、`end`、`cancel`）、`x`、`y`，坐标已转换到组件局部空间。

```javascript
let angle = 0;

return {
  onDrag({ phase, x }) {
    if (phase === 'cancel') {
      api.invalidate();
      return;
    }
    const ratio = Math.max(0, Math.min(1, x / Math.max(1, api.width)));
    angle = (ratio * 2 - 1) * Math.PI;
    api.invalidate();
    api.publish('targetAngle', angle);
  },
};
```

宿主负责命中测试、焦点、指针捕获与坐标转换。拖动可以持续到组件边界之外，失焦、系统取消或实例移除触发取消通知。第一版每个实例维护一个活动拖动指针，点击阈值由宿主统一确定。

拖动投递规则：

- `start`、`end`、`cancel` 按手势顺序逐条投递，节流保留这些阶段。
- `move` 按显示帧合并，只保留该帧最新坐标。
- `end` 携带最终坐标，并先清除该手势未投递的 `move`。
- `cancel` 清除待投递移动并结束拖动，保留此前已更新或发布的值。

## 时间与计算

需要持续模拟或周期计算的组件声明 `tick`：

```javascript
let angle = 0;
let velocity = 0;

return {
  tick({ dt, time }) {
    const acceleration = (torque - api.props.damping * velocity) / api.props.inertia;
    velocity += acceleration * dt;
    angle += velocity * dt;
    api.invalidate();
  },
};
```

- `dt` 为固定模拟步长，`time` 为当前步完成时的模拟时间，两者均为整数皮秒（口径见[虚拟时间](./0001-virtual-time.md)）。
- 宿主限制每帧补算步数，避免长时间暂停后无限追赶；暂停时固定步长计算保持暂停，属性与输入处理仍可进行。
- 宿主提供权威模拟时钟。每个固定模拟步先冻结本步待投递消息，再向实例统一投递，待投递回调处理完成后执行本步 `tick`。
- 本步投递回调与 `tick` 中发布的消息先缓存，到下一模拟步才对其他实例生效；步间外部输入在下一步开始时纳入待投递集合。
- 宿主等待参与实例完成本步后统一推进下一步，故障实例按故障策略退出步进屏障。
- 消息在下一模拟步生效，因此跨实例传播具有一个固定步长的通信延迟，并遵循统一步进边界。
- 固定模拟暂停时，周期计算与待投递消息一并冻结；普通界面通信继续按自身投递合同执行。

控制器可以订阅目标角度与当前角度，依据有效采样时间与采样间隔估算角速度；首个样本、重置或恢复时初始化估计，目标与反馈均有效时产生控制力矩。

## 资源访问

图片与二进制属性保存[资源引用](./0009-device-properties.md)（形如 `{ src, mode }`）。组件通过受控资源接口读取：

```javascript
const bitmap = await api.assets.loadImage(api.props.background);
const buffer = await api.assets.readBinary(api.props.calibration);
```

- 资源读取以当前实例的授权范围为依据。
- 图片返回独立 `ImageBitmap`，由调用方持有并在使用结束时调用 `close()`。
- 二进制返回独立 `ArrayBuffer`，调用方与宿主各自持有数据。
- 资源读取通过 Promise 返回结果或错误，组件处理相应状态。
- 异步加载由工厂内的辅助函数发起，工厂与绘制回调保持同步。
- 组件按请求代次接纳当前资源结果并释放过期位图。
- 更新提交以实例活动状态为前提；销毁时运行时终止更新通道并尽可能取消在途请求。

## 生命周期与错误

返回对象允许包含以下可选回调：

| 回调             | 职责                     |
| ---------------- | ------------------------ |
| `render(ctx)`    | 绘制当前状态             |
| `onResize(size)` | 响应尺寸变化             |
| `tick(step)`     | 固定步长业务计算         |
| `onClick(event)` | 点击处理                 |
| `onDrag(event)`  | 拖动处理                 |
| `onEvent(event)` | 其他输入事件             |
| `reset()`        | 恢复组件自身初始业务状态 |
| `dispose()`      | 释放组件持有的资源       |

生命周期约定：

1. 工厂执行前完成属性默认值解析；尺寸在宿主分配后生效。
2. 工厂返回后启用订阅、尺寸通知与其他回调。
3. 同一实例回调串行执行；Promise 后续仍需防止异步结果过期。
4. `reset` 恢复组件业务状态，保留当前属性与绑定。
5. 销毁先停止新事件与计算，再调用 `dispose`，最后清理订阅、通道与运行时资源。
6. `dispose` 最多调用一次；运行时会自动取消注册的监听器。
7. 运行时报告回调异常并暂停故障实例的后续业务调度。
8. 故障影响范围尽可能限制到实例，但同插件的共享执行环境仍可能受影响。

## 故障与手动恢复

- 任一参与模拟步进的实例异常或超时，宿主停止推进整个模拟，防止其他实例在缺失反馈的情况下继续计算。
- 故障实例停止业务输入与消息发布，退出当前步等待；全局模拟保持暂停。
- 保留最后可用画面并显示故障状态；相关输出标记为失效，最后值作为历史状态保留。
- 用户处理故障并手动重新初始化模拟后恢复步进；恢复采用重新初始化，使消息与实例内部数据重新建立一致的起始状态。
- 普通界面实例按实例范围隔离故障：其业务调度暂停，全局模拟保持原有状态。
