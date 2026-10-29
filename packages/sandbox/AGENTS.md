# Sandbox

- Pass only `MessagePort` across the sandbox boundary and create RPC with `createRpc(port)`; do not add a separate messaging protocol.
- The Vite plugin bundles guest code in memory as one self-contained IIFE; guest scripts are not published as separate files.
- Keep host security boundaries and typed service contracts intact.
