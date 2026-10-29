# Schematic editor

- `DocumentModel` owns `.sch` content and undo history; `SchematicEditor` owns interaction and viewport state. Respect ownership of an externally supplied model.
- `SchematicClipboard` payloads belong to `DocumentModel`; the system clipboard port, the in-editor buffer and the selection belong to `SchematicEditor`.
- Reuse core lifecycle `Event<T>` for editor events. Keep editor CSS opt-in through `@mica-js/schematic-editor/style.css`.
