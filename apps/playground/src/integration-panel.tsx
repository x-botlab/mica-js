import { Check, RotateCcw, Trash2, Unlink, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ICanvasEditor, IEditorProperty } from '@mica-js/editor';
import {
  errorMessage,
  propertyValue,
  targetId,
  targetKey,
  type EditorSession,
  type HostTarget,
} from './host-integration';
import './integration-panel.css';

type ICanvasBindingInfo = ReturnType<ICanvasEditor['getBindings']>[number];

type Perform = (owner: EditorSession, action: () => Promise<unknown>) => Promise<void>;
interface Props {
  session: EditorSession;
  open: boolean;
  focusProperties: number;
  busy: boolean;
  perform: Perform;
}
interface ObjectItem {
  target: HostTarget;
  label: string;
}
interface Metadata {
  objects: ObjectItem[];
  selection: readonly HostTarget[];
  properties: readonly IEditorProperty[];
  bindings: readonly ICanvasBindingInfo[];
  schematic: string;
}

function readMetadata(session: EditorSession): Metadata {
  if (session.kind === 'canvas') {
    const document = session.editor.getDocument();
    const selection = session.editor.getSelection();
    const id = selection[0]?.id;
    return {
      objects: document.widgets.map((widget) => ({
        target: { kind: 'widget', id: widget.id },
        label: widget.widget,
      })),
      selection,
      properties: id ? session.editor.getProperties(id) : [],
      bindings: id ? session.editor.getBindings(id) : [],
      schematic: document.schematic ?? '',
    };
  }
  const document = session.editor.getDocument();
  const selection = session.editor.getSelection();
  const target = selection[0];
  const id =
    target?.kind === 'symbol'
      ? target.id
      : target?.kind === 'reference' || target?.kind === 'pin'
        ? target.symbolId
        : undefined;
  return {
    objects: [
      ...document.sheet.symbols.map((symbol): ObjectItem => ({
        target: { kind: 'symbol', id: symbol.id },
        label: symbol.designator ?? symbol.net ?? symbol.device,
      })),
      ...document.sheet.wires.map((wire): ObjectItem => ({
        target: { kind: 'wire', id: wire.id },
        label: '导线',
      })),
      ...document.sheet.junctions.map((junction): ObjectItem => ({
        target: { kind: 'junction', id: junction.id },
        label: '连接点',
      })),
    ],
    selection,
    properties: id ? session.editor.getProperties(id) : [],
    bindings: [],
    schematic: '',
  };
}

function displayValue(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function PropertyField({
  property,
  disabled,
  save,
  reset,
}: {
  property: IEditorProperty;
  disabled: boolean;
  save(value: unknown): Promise<void>;
  reset(): Promise<void>;
}) {
  const serialized = displayValue(property.value);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setDraft(serialized);
    setError(undefined);
  }, [serialized, property.overridden]);
  const locked = disabled || property.readOnly;
  const submit = async () => {
    if (locked || property.options || property.type === 'boolean') return;
    try {
      let value: unknown = draft;
      if (property.type === 'number' || property.type === 'integer') {
        const number = Number(draft);
        if (!draft.trim() || !Number.isFinite(number)) throw new Error('请输入有限数字。');
        if (property.type === 'integer' && !Number.isInteger(number))
          throw new Error('请输入整数。');
        if (property.min !== undefined && number < property.min)
          throw new Error(`最小值为 ${property.min}。`);
        if (property.max !== undefined && number > property.max)
          throw new Error(`最大值为 ${property.max}。`);
        value = number;
      } else if (
        property.type === 'image' ||
        property.type === 'binary' ||
        (typeof property.value === 'object' && property.value !== null)
      ) {
        value = JSON.parse(draft);
      }
      await save(value);
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const optionIndex = property.options?.findIndex(
    (option) => JSON.stringify(option.value) === JSON.stringify(property.value),
  );
  // Choice controls commit immediately; free-form fields preserve a draft until submitted.
  const commitChoice = (value: unknown) => {
    void save(value).then(
      () => setError(undefined),
      (cause) => setError(errorMessage(cause)),
    );
  };
  return (
    <form
      className="host-property"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="host-property-heading">
        <label htmlFor={`property-${property.key}`} title={property.description}>
          {property.label}
        </label>
        <button
          type="button"
          title={`恢复默认值: ${displayValue(property.defaultValue)}`}
          aria-label={`重置 ${property.label}`}
          disabled={locked || !property.overridden}
          onClick={() => {
            void reset().then(
              () => setError(undefined),
              (cause) => setError(errorMessage(cause)),
            );
          }}
        >
          <RotateCcw size={13} />
        </button>
      </div>
      <div className="host-property-control">
        {property.options ? (
          <select
            id={`property-${property.key}`}
            disabled={locked}
            value={optionIndex === -1 ? '' : optionIndex}
            onChange={(event) => {
              const option = property.options?.[Number(event.target.value)];
              if (option) commitChoice(option.value);
            }}
          >
            <option value="" disabled>
              选择…
            </option>
            {property.options.map((option, index) => (
              <option key={index} value={index}>
                {option.label}
              </option>
            ))}
          </select>
        ) : property.type === 'boolean' ? (
          <input
            id={`property-${property.key}`}
            type="checkbox"
            disabled={locked}
            checked={property.value === true}
            onChange={(event) => commitChoice(event.target.checked)}
          />
        ) : (
          <>
            <input
              id={`property-${property.key}`}
              disabled={locked}
              value={draft}
              type={
                property.type === 'number' || property.type === 'integer'
                  ? 'number'
                  : property.type === 'color'
                    ? 'color'
                    : 'text'
              }
              min={property.min}
              max={property.max}
              step={property.step ?? (property.type === 'integer' ? 1 : 'any')}
              aria-invalid={error !== undefined}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button
              type="submit"
              disabled={locked}
              title="应用属性"
              aria-label={`应用 ${property.label}`}
            >
              <Check size={14} />
            </button>
          </>
        )}
      </div>
      <span className="host-muted host-default" title={displayValue(property.defaultValue)}>
        {property.overridden ? '已覆盖' : '默认'} ·{' '}
        {displayValue(property.defaultValue) || '未设置'}
      </span>
      {error ? (
        <p role="alert" className="host-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function IntegrationPanel({ session, open, focusProperties, busy, perform }: Props) {
  const [metadata, setMetadata] = useState(() => readMetadata(session));
  const [refreshError, setRefreshError] = useState<string>();
  const [clickInfo, setClickInfo] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; target: HostTarget | null }>();
  const [path, setPath] = useState(metadata.schematic);
  const [policy, setPolicy] = useState<'preserve' | 'clear'>('preserve');
  const propertiesRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const state = session.editor.getState();
  const locked = busy || state.readOnly || state.mode !== 'edit';
  const selected = metadata.selection[0];
  const selectedId = selected ? targetId(selected) : undefined;
  const propertyId =
    selected?.kind === 'widget' || selected?.kind === 'symbol'
      ? selected.id
      : selected && 'symbolId' in selected
        ? selected.symbolId
        : undefined;

  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (!active) return;
      try {
        setMetadata(readMetadata(session));
        setRefreshError(undefined);
      } catch (cause) {
        setRefreshError(errorMessage(cause));
      }
    };
    const subscriptions = [
      session.editor.onDidChangeContent(refresh),
      session.editor.onDidChangeSelection(refresh),
      session.editor.onDidChangeState(refresh),
      session.editor.onDidDoubleClick((event) => {
        if (!active) return;
        const target = event.target;
        try {
          if (session.kind === 'canvas') {
            if (target?.kind === 'widget') session.editor.setSelection([target]);
          } else if (target && target.kind !== 'widget') session.editor.setSelection([target]);
        } catch (cause) {
          setRefreshError(errorMessage(cause));
        }
      }),
      session.editor.onDidClick((event) => {
        if (active)
          setClickInfo(
            `${event.target ? `${event.target.kind} · ${targetId(event.target)}` : '空白'} · ${Math.round(event.position.x)}, ${Math.round(event.position.y)}`,
          );
      }),
      session.editor.onDidContextMenu((event) => {
        if (!active) return;
        returnFocus.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setMenu({
          x: Math.max(4, Math.min(event.clientPosition.x, globalThis.innerWidth - 190)),
          y: Math.max(4, Math.min(event.clientPosition.y, globalThis.innerHeight - 120)),
          target: event.target,
        });
      }),
    ];
    refresh();
    return () => {
      active = false;
      subscriptions.forEach((subscription) => subscription.dispose());
    };
  }, [session]);
  useEffect(() => {
    setPath(metadata.schematic);
  }, [metadata.schematic]);
  useEffect(() => {
    if (open && focusProperties > 0) propertiesRef.current?.focus();
  }, [focusProperties, open]);
  const closeMenu = () => {
    setMenu(undefined);
    returnFocus.current?.focus();
  };
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        setMenu(undefined);
        returnFocus.current?.focus();
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = Array.from(
          menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
        );
        const index = buttons.findIndex((button) => button === document.activeElement);
        buttons[
          (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        ]?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target))
        setMenu(undefined);
    };
    globalThis.addEventListener('keydown', key);
    globalThis.addEventListener('pointerdown', outside, true);
    return () => {
      globalThis.removeEventListener('keydown', key);
      globalThis.removeEventListener('pointerdown', outside, true);
    };
  }, [menu]);

  const select = (target: HostTarget | null) => {
    if (busy) return;
    try {
      if (session.kind === 'canvas') {
        if (target === null || target.kind === 'widget')
          session.editor.setSelection(target ? [target] : []);
      } else if (target?.kind !== 'widget') session.editor.setSelection(target ? [target] : []);
    } catch (cause) {
      setRefreshError(errorMessage(cause));
    }
  };
  const action = (task: () => Promise<unknown>) => perform(session, task);
  const changeProperty = (key: string, value: unknown) =>
    action(async () => {
      if (!propertyId) return;
      if (session.kind === 'canvas')
        return session.editor.executeCommand('canvas.setProperties', {
          instanceId: propertyId,
          values: { [key]: value },
        });
      return session.editor.executeCommand('schematic.setProperties', {
        symbolId: propertyId,
        values: { [key]: propertyValue(value) },
      });
    });
  const resetProperty = (key: string) =>
    action(async () => {
      if (!propertyId) return;
      if (session.kind === 'canvas')
        return session.editor.executeCommand('canvas.setProperties', {
          instanceId: propertyId,
          values: {},
          remove: [key],
        });
      return session.editor.executeCommand('schematic.setProperties', {
        symbolId: propertyId,
        values: {},
        remove: [key],
      });
    });
  const unlink = () => {
    if (session.kind === 'canvas')
      void action(() =>
        session.editor.executeCommand('canvas.setSchematic', { path: null, bindings: 'clear' }),
      ).catch(() => undefined);
  };

  return (
    <>
      <aside className="host-sidebar" hidden={!open} aria-label="文档属性">
        <section>
          <h2>
            文档对象 <span className="host-muted">{metadata.objects.length}</span>
          </h2>
          <div className="host-object-list" role="group" aria-label="文档对象">
            {metadata.objects.length === 0 ? (
              <p className="host-muted">无对象</p>
            ) : (
              metadata.objects.map(({ target, label }) => (
                <button
                  type="button"
                  key={targetKey(target)}
                  disabled={busy}
                  aria-pressed={metadata.selection.some(
                    (item) => targetKey(item) === targetKey(target),
                  )}
                  onClick={() => select(target)}
                >
                  <span>{label}</span>
                  <small>
                    {target.kind} · {targetId(target)}
                  </small>
                </button>
              ))
            )}
          </div>
          <button
            type="button"
            className="host-text-button"
            disabled={busy || metadata.selection.length === 0}
            onClick={() => select(null)}
          >
            清除选择
          </button>
        </section>
        {session.kind === 'canvas' ? (
          <section>
            <h2>关联原理图</h2>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!path.trim()) return;
                void action(() =>
                  session.editor.executeCommand('canvas.setSchematic', {
                    path: path.trim(),
                    bindings: policy,
                  }),
                ).catch(() => undefined);
              }}
            >
              <label htmlFor="schematic-path">路径</label>
              <input
                id="schematic-path"
                list="schematic-candidates"
                value={path}
                disabled={locked}
                onChange={(event) => setPath(event.target.value)}
                placeholder="example.sch"
              />
              <datalist id="schematic-candidates">
                <option value="example.sch" />
              </datalist>
              <label htmlFor="binding-policy">已有绑定</label>
              <select
                id="binding-policy"
                value={policy}
                disabled={locked}
                onChange={(event) =>
                  setPolicy(event.target.value === 'clear' ? 'clear' : 'preserve')
                }
              >
                <option value="preserve">保留绑定</option>
                <option value="clear">清除绑定</option>
              </select>
              <div className="host-inline-actions">
                <button
                  type="submit"
                  className="host-text-button"
                  disabled={locked || !path.trim()}
                >
                  应用
                </button>
                <button
                  type="button"
                  className="host-text-button"
                  disabled={locked || !metadata.schematic}
                  onClick={unlink}
                >
                  <Unlink size={13} />
                  取消关联
                </button>
              </div>
            </form>
          </section>
        ) : null}
        <section ref={propertiesRef} tabIndex={-1} aria-label="所选对象属性">
          <h2>
            属性 <span className="host-muted">{metadata.selection.length || ''}</span>
          </h2>
          <p className="host-muted host-selected" title={selectedId}>
            {selected ? `${selected.kind} · ${selectedId}` : '未选择对象'}
          </p>
          {metadata.properties.length === 0 && selected ? (
            <p className="host-muted">无可编辑属性</p>
          ) : null}
          {metadata.properties.map((property) => (
            <PropertyField
              key={`${propertyId}:${property.key}`}
              property={property}
              disabled={locked}
              save={(value) => changeProperty(property.key, value)}
              reset={() => resetProperty(property.key)}
            />
          ))}
        </section>
        {session.kind === 'canvas' && metadata.bindings.length > 0 ? (
          <section>
            <h2>端口绑定</h2>
            {metadata.bindings.map((binding) => {
              const bindingKey = (target: { symbol: string; port: string } | null) =>
                target ? JSON.stringify([target.symbol, target.port]) : '';
              const current = bindingKey(binding.target);
              return (
                <label className="host-binding" key={binding.port}>
                  {binding.port}
                  <small className="host-muted">
                    {binding.direction} · {binding.type}
                  </small>
                  <select
                    disabled={locked}
                    value={current}
                    onChange={(event) => {
                      const candidate = binding.candidates.find(
                        (item) => bindingKey(item.target) === event.target.value,
                      );
                      if (!selectedId || (event.target.value && !candidate?.compatible)) return;
                      void action(() =>
                        session.editor.executeCommand('canvas.setBinding', {
                          instanceId: selectedId,
                          port: binding.port,
                          target: candidate?.target ?? null,
                        }),
                      ).catch(() => undefined);
                    }}
                  >
                    <option value="">未绑定</option>
                    {current &&
                    !binding.candidates.some(
                      (candidate) => bindingKey(candidate.target) === current,
                    ) ? (
                      <option value={current} disabled>
                        {binding.target?.symbol}.{binding.target?.port}（不可用）
                      </option>
                    ) : null}
                    {binding.candidates.map((candidate) => (
                      <option
                        key={bindingKey(candidate.target)}
                        value={bindingKey(candidate.target)}
                        disabled={!candidate.compatible}
                        title={candidate.reason}
                      >
                        {candidate.label}
                        {!candidate.compatible ? ` · ${candidate.reason ?? '不兼容'}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </section>
        ) : null}
        {refreshError ? (
          <p role="alert" className="host-error">
            {refreshError}
          </p>
        ) : null}
      </aside>
      <div className="host-selection-status" role="status">
        {busy
          ? '正在应用…'
          : state.readOnly
            ? '只读'
            : state.mode === 'simulation'
              ? state.running
                ? '运行中'
                : '仿真已暂停'
              : metadata.selection.length
                ? `已选择 ${metadata.selection.length} 项`
                : '就绪'}
        {clickInfo ? ` · ${clickInfo}` : ''}
      </div>
      {menu ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="对象操作"
          className="host-context-menu"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            type="button"
            role="menuitem"
            disabled={busy || !menu.target}
            onClick={() => {
              select(menu.target);
              closeMenu();
              propertiesRef.current?.focus();
            }}
          >
            <Check size={14} />
            选择对象
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={locked || (!menu.target && metadata.selection.length === 0)}
            onClick={() => {
              if (menu.target) select(menu.target);
              const target = menu.target ?? selected;
              closeMenu();
              void action(async () => {
                if (session.kind === 'canvas') {
                  if (target?.kind === 'widget')
                    return session.editor.executeCommand('canvas.removeWidget', {
                      instanceId: target.id,
                    });
                } else return session.editor.executeCommand('schematic.deleteSelection');
              }).catch(() => undefined);
            }}
          >
            <Trash2 size={14} />
            删除
          </button>
          <button type="button" role="menuitem" onClick={closeMenu}>
            <X size={14} />
            关闭
          </button>
        </div>
      ) : null}
    </>
  );
}
