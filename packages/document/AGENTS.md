# Document

- Keep the `.sch` and `.cnv` contracts pure data plus document operations; editor state, interaction and rendering belong to editor packages.
- Keep `schematic` and `canvas` public subpaths aligned with both export maps when changing an entry.
- Only the `TimePs` type may come from `@mica-js/core`; do not add simulator or editor dependencies.
