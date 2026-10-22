/**
 * Editor chrome. Injected as a single `<style>` element so the package needs no CSS pipeline,
 * matching `@mica-js/schematic-editor`.
 */
export const CANVAS_EDITOR_STYLES = `
.mica-canvas-editor {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  overflow: hidden;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

.mica-canvas-editor__surface {
  display: block;
  width: 100%;
  height: 100%;
  outline: none;
  touch-action: none;
}
`;
