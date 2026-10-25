---
'@mica-js/core': minor
'@mica-js/device': minor
---

新增 RFC 0010 Topic 载荷布局校验，让宿主在投递前拒绝布局非法的字节载荷：

- `@mica-js/device` 导出 `validateTopicPayload(value, type, path?, options?)`、`validateRgb565Layout(data, path?)` 与 `validateSegmentsLayout(data, segmentCount, path?)`，返回 `{ valid: true }` 或 `{ valid: false, error: { code, description, path, message } }`。表示层与布局分开检查，`captureTopicPayload` 的捕获行为不变。
- `bytes<rgb565>`（RFC 0010 §2.7）：8 字节小端头（`uint16 width`、`uint16 height`、`uint32 reserved`），宽高必须为正整数，总长度必须等于 `8 + width × height × 2`；报错消息给出完整算式（如 `expected 520 (8 + 16 × 16 × 2), got 100`）。
- `bytes<segments>`（RFC 0010 §2.8）：每字节表示 8 段，长度必须等于 `ceil(segmentCount / 8)`；段数由宿主通过 `options.segmentCount` 从器件定义传入，缺省时只拒绝空载荷。段数本身必须是正整数。
- `@mica-js/core` 新增 `SCHEMA_ERROR_CODES` 与 `SchemaErrorCode`（`schema/invalid-value`、`schema/unknown-field`、`schema/type-mismatch`），从 `@mica-js/core/canvas` 与 `@mica-js/core/schematic` 导出；`DeviceErrorCode` 复用同一联合类型。
- 新增 `packages/device/src/messaging/payload.test.ts`（19 例，覆盖合法布局、长度不符、零宽高、头部不足 8 字节、视图 `byteOffset`、段数上限与表示层类型错误）。
