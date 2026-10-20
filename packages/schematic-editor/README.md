# @mica/schematic-editor

原理图与 2D 视图的 Canvas 编辑器，渲染 `@mica/core/schematic` 的文档。

## 入口

- 包根导出主题（`SchematicTheme`、`DARK_SCHEMATIC_THEME`、`LIGHT_SCHEMATIC_THEME`、`resolveSchematicTheme`、`themeToCssVariables`）与场景/视口类型。
- 视口、场景构建与 Canvas 渲染器为内部模块。

## 开发

```bash
pnpm --filter @mica/schematic-editor run dev        # 打开 demo 预览
pnpm --filter @mica/schematic-editor run test
pnpm --filter @mica/schematic-editor run typecheck
pnpm --filter @mica/schematic-editor run build
```
