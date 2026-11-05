# Simulator

- Consumers supply device models and synchronous factories; the SDK runs in the caller's thread.
- Reuse `@mica-js/device-model` for canonical IR/Builder validation and `@mica-js/compiler` for model execution.
- Keep Langium loading behind the separate `/ddl` entry; core runtime sources stay browser-compatible.
- Preserve publication boundaries, capture-before-body ordering and existing instruction continuations when optimizing execution.
- Validate changes with the real conformance adapter and generated oracles described in [README.md](./README.md); keep Node-only measurements under `bench/`.
