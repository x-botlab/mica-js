---
'@mica-js/schematic-editor': patch
---

修复框选 T 型连接后删除报未知交点：删除导线时已顺带移除的交点不再重复删除，整笔删除不再回滚。
