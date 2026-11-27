---
'@mica-js/compiler': patch
---

Fix Direct JIT loop folding so completed rounds update the service accumulator according to the verified instruction tail, including when the accumulator starts at zero or no service deadline is active. Preserve the accumulator for empty tails and execute unproven tails one instruction at a time.
