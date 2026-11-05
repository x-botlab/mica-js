import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Download, Plus, Redo2, Undo2 } from 'lucide-react';
import { serializeSchematic, type SchematicDocument } from '@mica-js/document/schematic';
import { validateMetadata, type DeviceMetadata } from '@mica-js/sdk/metadata';
import { createSchematicEditor, type ISchematicEditor } from '@mica-js/editor';
import '@mica-js/editor/style.css';
import './device-demo.css';

const deviceIds = ['resistor', 'led', 'meter'] as const;
async function read(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

function DeviceDemo() {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<ISchematicEditor | undefined>(undefined);
  const latest = useRef<SchematicDocument | undefined>(undefined);
  const [selected, setSelected] = useState<string>('resistor');
  const [definitions, setDefinitions] = useState<Record<string, unknown>>({});
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [count, setCount] = useState(3);

  useEffect(() => {
    let disposed = false;
    let instance: ISchematicEditor | undefined;
    let subscription: { dispose(): void } | undefined;
    async function mount() {
      const entries = await Promise.all(
        deviceIds.map(async (id) => {
          const bytes = await read(`/device-demo/${id}.json`);
          const definition: unknown = JSON.parse(new TextDecoder().decode(bytes));
          validateMetadata(definition, 'device', id);
          return [id, definition as DeviceMetadata] as const;
        }),
      );
      if (disposed || !container.current) return;
      setDefinitions(Object.fromEntries(entries));
      const uri = new URL('/device-demo/example.sch', location.href).href;
      const initial = await read(uri);
      latest.current = JSON.parse(new TextDecoder().decode(initial)) as SchematicDocument;
      instance = await createSchematicEditor({
        container: container.current,
        uri,
        fileSystem: { read },
        deviceLibrary: {
          resolve: async (id) => {
            const definition = entries.find(([key]) => id === `demo:${key}`)?.[1];
            return definition ? { definition, code: '' } : undefined;
          },
        },
        theme: {
          background: '#fafafa',
          grid: '#eeeeee',
          gridMajor: '#dddddd',
          symbolFill: '#ffffff',
          symbolStroke: '#333333',
          symbolText: '#333333',
          pin: '#333333',
          pinText: '#555555',
          wire: '#39735a',
          labelText: '#333333',
          selection: '#167350',
          hover: '#167350',
          uiBackground: '#ffffff',
          uiSurface: '#ffffff',
          uiBorder: '#dddddd',
          uiText: '#222222',
          uiMutedText: '#666666',
          uiAccent: '#167350',
          uiAccentText: '#ffffff',
          pinFontSize: 10,
        },
      });
      if (disposed) {
        await instance.dispose();
        return;
      }
      editor.current = instance;
      subscription = instance.onDidChangeContent((value) => {
        latest.current = value;
        setCount(value.sheet.symbols.length);
      });
      setReady(true);
    }
    void mount().catch((reason: unknown) => {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      disposed = true;
      subscription?.dispose();
      editor.current = undefined;
      void instance?.dispose();
    };
  }, []);

  async function execute(command: string, ...args: unknown[]) {
    try {
      await editor.current?.executeCommand(command, ...args);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  function download() {
    if (!latest.current) return;
    const url = URL.createObjectURL(
      new Blob([serializeSchematic(latest.current)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'device-demo.sch';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <main className="demo">
      <header className="demo-header">
        <h1>
          Mica <span>Device Demo</span>
        </h1>
        <div className="demo-actions">
          <button
            title="撤销"
            aria-label="撤销"
            disabled={!ready}
            onClick={() => void execute('schematic.undo')}
          >
            <Undo2 size={18} />
          </button>
          <button
            title="重做"
            aria-label="重做"
            disabled={!ready}
            onClick={() => void execute('schematic.redo')}
          >
            <Redo2 size={18} />
          </button>
          <button title="下载原理图" aria-label="下载原理图" disabled={!ready} onClick={download}>
            <Download size={18} />
          </button>
        </div>
      </header>
      <section className="demo-workspace">
        <div className="demo-surface" ref={container} aria-label="原理图编辑器" />
        <aside className="demo-source">
          <div className="demo-source-heading">
            <select
              aria-label="器件定义"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              {deviceIds.map((id) => (
                <option key={id} value={id}>
                  {id}.json
                </option>
              ))}
            </select>
            <button
              title="放置器件"
              aria-label="放置器件"
              disabled={!ready}
              onClick={() => void execute('schematic.placeDevice', `demo:${selected}`)}
            >
              <Plus size={18} />
            </button>
          </div>
          <pre tabIndex={0}>{JSON.stringify(definitions[selected] ?? {}, null, 2)}</pre>
        </aside>
      </section>
      <footer className="demo-status" role="status">
        {error || (ready ? `${count} 个器件 · device.json` : '加载中…')}
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<DeviceDemo />);
