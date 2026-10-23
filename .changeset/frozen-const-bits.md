---
'@mica-js/ir': patch
---

`const.bits` 现在返回冻结的 `FloatBits` 对象。SSA 中的浮点值一律冻结，宿主经 executor operands 或函数返回值拿到该对象时不能再就地修改；位串仍保持字面量原样。
