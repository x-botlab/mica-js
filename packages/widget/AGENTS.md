# Widget

- Keep `host/`, `guest/`, `package/`, `host-fs/` and `build/` responsibilities distinct.
- HostFs crosses worker boundaries through typed RPC; use transfer hooks for byte buffers. Widget audio uses its own `MessagePort` to the worklet.
- Bundle guest and AudioWorklet code inline as self-contained scripts; do not publish standalone runtime assets.
