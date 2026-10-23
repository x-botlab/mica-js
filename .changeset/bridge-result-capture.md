---
'@mica-js/ir': patch
---

`bridge.send` 与 `bridge.send_bytes` 的宿主返回值现在经 `captureArgument('bool')` 捕获。宿主返回非 boolean 时（例如 `1`、`undefined`、`'true'`）以 `evaluation-failed` 失败，`steps` 与 `location` 指向该 bridge 指令，解释器随即 faulted。
