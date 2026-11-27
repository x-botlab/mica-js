---
'@mica-js/compiler': patch
---

Support proven Direct JIT service tails in fixed-duration span prefixes and self-jump loops. The compiler checks that the bound blocking guard remains stable and applies each prefix's elapsed update before the terminal instruction. Byte-counter folding also recognizes equivalent decrements masked again by the byte store.
