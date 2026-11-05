# Core

- Keep virtual time and scheduling deterministic; do not introduce wall-clock dependencies.
- Keep `rpc`, `logging` and `lifecycle` public subpaths aligned with both export maps when changing an entry.
- Shared RPC, events and disposal primitives belong here; other packages should reuse them.
