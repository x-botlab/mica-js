# Schematic editor

- `DocumentModel` owns `.sch` content and undo history; `SchematicEditor` owns interaction and viewport state. Respect ownership of an externally supplied model.
- Reuse core lifecycle `Event<T>` for editor events. Keep editor CSS opt-in through `@mica-js/schematic-editor/style.css`.
