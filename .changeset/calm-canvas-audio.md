---
'@mica-js/editor': minor
'@mica-js/widget': patch
---

Add editor-owned canvas audio playback with user-gesture unlocking, simulation pause/resume integration, and automatic AudioContext cleanup. Preserve audio suspension requested before the first widget mounts.

Make the canvas simulation step configurable through `stepMs`, defaulting to 20 ms. Schedule frames against fixed deadlines and skip missed slots without overlapping or accumulating simulation work.
