---
'@mica-js/compiler': minor
'@mica-js/simulator': minor
'@mica-js/sdk': minor
'@mica-js/editor': minor
---

Add opt-in scheduler-bounded batch execution for device processes and JIT loops.

- `@mica-js/compiler`: prove process and JIT loop batch plans from validated IR, including the process loop-to-resume-block mapping consumed by the simulator.
- `@mica-js/simulator`: add `BoardOptions.batchExecution` (default `false`), `DeviceContext.registerProcessBatch` with `ProcessBatchRegistration`, and `JitTranslateInput.markBatchLoop` with `JitBatchMark`. Prepared simulation loads validate the scalar switch, forward it to the board and keep it across reset.
- `@mica-js/sdk`: re-export the batch declaration types from the device entry and accept the forwarded `batchExecution` switch in `HeadlessRuntimeOptions`. Fused `ModelBinding` forwards `registerProcessBatch` to the simulator context, and a rejected option keeps preparation and the active session untouched.
- `@mica-js/editor`: carry `batchExecution` through the canvas simulation configuration and the fused runtime load request so the typed RPC guest creates and rebuilds boards with the captured switch.
