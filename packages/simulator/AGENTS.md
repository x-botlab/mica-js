# Simulator

- Keep generic circuit compilation/runtime separate from concrete device libraries; consumers supply device descriptions and resolution.
- `host/` owns the `DeviceSimulationHost` contract; `guest/` implements the sandbox side over typed core RPC.
- Keep the sandbox guest self-contained and inlined during the package build; do not add a published guest script entry.
