import {
  DARK_SCHEMATIC_THEME,
  LIGHT_SCHEMATIC_THEME,
  mountSchematicEditor,
  type EditorState,
  type MountedSchematicEditor,
} from '@mica-js/schematic-editor';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getDeviceRegistry } from '@/lib/registry';
import type { SchematicExample } from '@/schematic/examples';

export interface SchematicExampleViewProps {
  readonly dark: boolean;
  readonly example: SchematicExample;
}

/**
 * Shared host for every schematic example: one editor, a compact toolbar and the
 * shared device registry. Pages stay declarative and only supply a document.
 */
export function SchematicExampleView({ dark, example }: SchematicExampleViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MountedSchematicEditor | null>(null);
  const [state, setState] = useState<EditorState | null>(null);
  const [zoom, setZoom] = useState(1);
  const [readOnly, setReadOnly] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    const editor = mountSchematicEditor({
      container: host,
      schematic: example.document,
      devices: getDeviceRegistry(),
      theme: dark ? DARK_SCHEMATIC_THEME : LIGHT_SCHEMATIC_THEME,
      readOnly,
      onChange: setState,
      onViewportChange: (viewport) => setZoom(viewport.scale),
    });
    editorRef.current = editor;
    setState(editor.controller.getState());
    setZoom(editor.getViewport().scale);
    if (import.meta.env.DEV) {
      // Console handle the e2e suite uses to inspect the mounted editor.
      Object.assign(globalThis, { mica: editor });
    }
    return () => {
      editor.dispose();
      editorRef.current = null;
    };
    // `readOnly` is fixed at mount time, so toggling it remounts; the theme has its own effect.
  }, [example, readOnly]);

  useEffect(() => {
    editorRef.current?.setTheme(dark ? DARK_SCHEMATIC_THEME : LIGHT_SCHEMATIC_THEME);
  }, [dark]);

  const symbolCount = state?.document.sheet.symbols.length ?? example.document.sheet.symbols.length;
  const wireCount = state?.document.sheet.wires.length ?? example.document.sheet.wires.length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3" data-example={example.id}>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <Button size="xs" variant="outline" onClick={() => editorRef.current?.fitToContent()}>
          适应内容
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={state?.canUndo !== true}
          onClick={() => editorRef.current?.undo()}
        >
          撤销
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={state?.canRedo !== true}
          onClick={() => editorRef.current?.redo()}
        >
          重做
        </Button>
        <label className="ml-1 flex items-center gap-1.5 text-[11px]">
          <input
            type="checkbox"
            className="accent-primary size-3.5"
            checked={readOnly}
            onChange={(event) => setReadOnly(event.target.checked)}
          />
          只读
        </label>
        <p className="text-muted-foreground ml-2 min-w-0 truncate text-[11px]">{example.summary}</p>
        <div className="text-muted-foreground ml-auto flex shrink-0 items-center gap-2 text-[11px]">
          <span className="font-mono">
            {symbolCount} 器件 · {wireCount} 导线
          </span>
          <Badge variant="muted" className="font-mono">
            {zoom.toFixed(2)}×
          </Badge>
        </div>
      </div>
      <div
        ref={hostRef}
        className="bg-card min-h-0 flex-1 overflow-hidden rounded-xl border"
        data-editor={example.id}
      />
    </div>
  );
}
