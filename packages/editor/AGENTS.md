# Editor

- Keep schematic and canvas editors in independent composition roots with separate factory functions. Share DI and lifecycle infrastructure; each instance runs one editor type.
- Keep editor CSS opt-in through a dedicated `style.css` subpath.
