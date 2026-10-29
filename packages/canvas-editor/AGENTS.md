# Canvas editor

- The editor owns the widget host created by `HostProvider`; the host owns the `.cnv` document. Apply changes through host commands and render committed snapshots.
- Synchronize edit/simulation mode before loading a document; release owned hosts with `dispose()`.
- Keep editor CSS opt-in through `@mica-js/canvas-editor/style.css`.
