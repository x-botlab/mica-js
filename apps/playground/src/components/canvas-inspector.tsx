import type { CanvasCommand, CanvasWidgetInstance } from '@mica-js/core/canvas';
import type { CanvasMode } from '@mica-js/canvas-editor';
import type { PortDefinition, PropertyDefinition, WidgetDefinition } from '@mica-js/widget';
import { useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  assetRefOf,
  bindingOptions,
  bindingTargetOf,
  describeTarget,
  isPropertyOverridden,
  parseTargetValue,
  propertyInitialValue,
  targetValue,
  type TopicCandidate,
} from '@/canvas/panel-model';

/** Applies one command; the returned messages come from `SchematicError.diagnostics`. */
export type CanvasCommandApplier = (command: CanvasCommand) => readonly string[];

export interface CanvasInspectorProps {
  readonly mode: CanvasMode;
  readonly instance: CanvasWidgetInstance | undefined;
  readonly definition: WidgetDefinition | undefined;
  /** The selected widget reference is still resolving, so no definition is available yet. */
  readonly resolving: boolean;
  /** Bumped whenever the document changes, so field drafts reseed from the committed values. */
  readonly revision: number;
  /** Endpoints the running schematic offers; empty while no simulation is loaded. */
  readonly targets: readonly TopicCandidate[];
  readonly onApply: CanvasCommandApplier;
}

function valueToText(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** Truthiness is not enough: `0` and `false` differ, and objects compare by content. */
function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ErrorLines({ messages }: { readonly messages: readonly string[] }) {
  if (messages.length === 0) {
    return null;
  }
  return (
    <ul className="mt-1 space-y-0.5 text-[10px] text-red-400">
      {messages.map((message, index) => (
        <li key={index}>{message}</li>
      ))}
    </ul>
  );
}

interface FieldProps {
  readonly instance: CanvasWidgetInstance;
  readonly propertyKey: string;
  readonly descriptor: PropertyDefinition;
  readonly disabled: boolean;
  readonly onApply: CanvasCommandApplier;
}

function PropertyField({ instance, propertyKey, descriptor, disabled, onApply }: FieldProps) {
  const initial = propertyInitialValue(instance, propertyKey, descriptor);
  const overridden = isPropertyOverridden(instance, propertyKey);
  const [draft, setDraft] = useState(() => valueToText(initial));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [errors, setErrors] = useState<readonly string[]>([]);

  const commit = (value: unknown): void => {
    if (disabled || sameValue(value, initial)) {
      return;
    }
    setErrors(onApply({ type: 'set-property', instanceId: instance.id, key: propertyKey, value }));
  };

  const parseNumber = (text: string): number | undefined => {
    if (text.trim() === '') {
      setErrors([`${propertyKey} 需要一个数字。`]);
      return undefined;
    }
    const value = Number(text);
    if (!Number.isFinite(value)) {
      setErrors([`${propertyKey} 需要一个数字。`]);
      return undefined;
    }
    return value;
  };

  const commitNumber = (text: string): void => {
    const value = parseNumber(text);
    if (value !== undefined) commit(value);
  };

  let control: ReactNode;
  switch (descriptor.type) {
    case 'boolean':
      control = (
        <input
          type="checkbox"
          className="size-3.5 accent-sky-500"
          checked={initial === true}
          disabled={disabled}
          onChange={(event) => commit(event.target.checked)}
          aria-label={propertyKey}
        />
      );
      break;
    case 'number':
    case 'integer':
      control = (
        <input
          type="number"
          className="bg-background w-full rounded border px-1.5 py-1 font-mono text-[11px]"
          step={descriptor.type === 'integer' ? 1 : 'any'}
          defaultValue={valueToText(initial)}
          disabled={disabled}
          onBlur={(event) => commitNumber(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitNumber(event.currentTarget.value);
          }}
          aria-label={propertyKey}
        />
      );
      break;
    case 'color':
      control = (
        <div className="flex items-center gap-1">
          <input
            type="color"
            className="h-6 w-8 shrink-0 rounded border bg-transparent"
            value={/^#[0-9a-f]{6}$/i.test(draft) ? draft : '#000000'}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commit(event.target.value)}
            aria-label={`${propertyKey} 颜色`}
          />
          <input
            type="text"
            className="bg-background w-full rounded border px-1.5 py-1 font-mono text-[11px]"
            defaultValue={valueToText(initial)}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit(event.currentTarget.value);
            }}
            aria-label={propertyKey}
          />
        </div>
      );
      break;
    case 'string':
      control = (
        <input
          type="text"
          className="bg-background w-full rounded border px-1.5 py-1 font-mono text-[11px]"
          defaultValue={valueToText(initial)}
          disabled={disabled}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(event.currentTarget.value);
          }}
          aria-label={propertyKey}
        />
      );
      break;
    case 'image':
    case 'binary': {
      const ref = assetRefOf(initial);
      control = (
        <div className="flex flex-col gap-0.5">
          <input
            type="text"
            className="bg-background w-full rounded border px-1.5 py-1 font-mono text-[11px]"
            defaultValue={ref?.src ?? ''}
            placeholder="assets/panel.png"
            disabled={disabled}
            onBlur={(event) => commit({ src: event.target.value, mode: ref?.mode ?? 'file' })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commit({ src: event.currentTarget.value, mode: ref?.mode ?? 'file' });
              }
            }}
            aria-label={`${propertyKey} src`}
          />
          <span className="text-muted-foreground text-[10px]">
            {`{ src, mode: ${ref?.mode ?? 'file'} } · 资源在实例挂载时预取`}
          </span>
        </div>
      );
      break;
    }
    default:
      control = (
        <textarea
          className={
            jsonError === null
              ? 'bg-background min-h-16 w-full rounded border px-1.5 py-1 font-mono text-[11px]'
              : 'min-h-16 w-full rounded border border-red-500 bg-red-500/10 px-1.5 py-1 font-mono text-[11px]'
          }
          defaultValue={valueToText(initial)}
          disabled={disabled}
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            try {
              JSON.parse(text);
              setJsonError(null);
            } catch (error) {
              setJsonError(error instanceof Error ? error.message : String(error));
            }
          }}
          onBlur={(event) => {
            const text = event.target.value;
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch (error) {
              setJsonError(error instanceof Error ? error.message : String(error));
              return;
            }
            setJsonError(null);
            commit(parsed);
          }}
          aria-label={propertyKey}
        />
      );
      break;
  }

  return (
    <div className="border-b py-1.5 last:border-b-0" data-property={propertyKey}>
      <div className="flex items-center gap-1">
        <span className="font-mono text-[11px]">{propertyKey}</span>
        <span className="text-muted-foreground text-[10px]">{descriptor.type}</span>
        {overridden ? (
          <Badge variant="secondary" className="h-4 px-1 text-[9px]">
            已覆盖
          </Badge>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto h-5 px-1 text-[10px]"
          disabled={disabled || !overridden}
          onClick={() =>
            setErrors(
              onApply({ type: 'unset-property', instanceId: instance.id, key: propertyKey }),
            )
          }
          title="删除文档里的覆盖值，回到定义默认值"
        >
          重置
        </Button>
      </div>
      <div className="mt-1">{control}</div>
      <ErrorLines messages={errors} />
      {jsonError === null ? null : (
        <p className="mt-1 text-[10px] text-red-400">JSON 解析失败：{jsonError}</p>
      )}
    </div>
  );
}

interface BindingFieldProps {
  readonly instance: CanvasWidgetInstance;
  readonly portKey: string;
  readonly port: PortDefinition;
  readonly targets: readonly TopicCandidate[];
  readonly disabled: boolean;
  readonly onApply: CanvasCommandApplier;
}

function BindingField({ instance, portKey, port, targets, disabled, onApply }: BindingFieldProps) {
  const [errors, setErrors] = useState<readonly string[]>([]);
  const options = bindingOptions(instance, portKey, port, targets);
  const current = bindingTargetOf(instance, portKey);

  return (
    <div className="border-b py-1.5 last:border-b-0" data-port={portKey}>
      <div className="flex items-center gap-1">
        <span className="font-mono text-[11px]">{portKey}</span>
        <span className="text-muted-foreground text-[10px]">
          {port.direction} · {port.type}
        </span>
      </div>
      <select
        className="bg-background mt-1 w-full rounded border px-1.5 py-1 text-[11px]"
        value={current === undefined ? '' : targetValue(current)}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          setErrors(
            onApply({
              type: 'set-binding',
              instanceId: instance.id,
              port: portKey,
              target: next === '' ? null : (parseTargetValue(next) ?? null),
            }),
          );
        }}
        aria-label={`${portKey} 绑定`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <p className="text-muted-foreground mt-0.5 text-[10px]">
        {current === undefined
          ? '未绑定：运行/仿真消息不会到达这个端口。'
          : `当前 ${describeTarget(current)}`}
      </p>
      <ErrorLines messages={errors} />
    </div>
  );
}

export function CanvasInspector({
  mode,
  instance,
  definition,
  resolving,
  revision,
  targets,
  onApply,
}: CanvasInspectorProps) {
  const readOnly = mode === 'run';
  const properties = definition === undefined ? [] : Object.entries(definition.properties);
  const ports = definition === undefined ? [] : Object.entries(definition.ports);

  return (
    <div className="flex flex-col">
      <section className="flex flex-col">
        <header className="flex items-center gap-2 border-b px-3 py-2">
          <h2 className="text-xs font-semibold">属性</h2>
          <span className="text-muted-foreground truncate font-mono text-[10px]">
            {instance?.widget ?? '—'}
          </span>
        </header>
        <div className="max-h-72 overflow-y-auto px-3 py-1">
          {readOnly ? (
            <p className="text-muted-foreground px-0 py-1 text-[10px]">
              运行模式只读；切回「编辑」才能修改属性与绑定。
            </p>
          ) : null}
          {instance === undefined ? (
            <p className="text-muted-foreground py-1 text-[11px]">未选中实例：在画布上点一个。</p>
          ) : resolving ? (
            <p className="text-muted-foreground py-1 text-[11px]">正在解析 widget 定义…</p>
          ) : definition === undefined ? (
            <p className="py-1 text-[11px] text-red-400">找不到 {instance.widget} 的定义。</p>
          ) : properties.length === 0 ? (
            <p className="text-muted-foreground py-1 text-[11px]">该 widget 没有属性。</p>
          ) : (
            properties.map(([key, descriptor]) => (
              <PropertyField
                key={`${instance.id}:${key}:${revision}`}
                instance={instance}
                propertyKey={key}
                descriptor={descriptor}
                disabled={readOnly}
                onApply={onApply}
              />
            ))
          )}
        </div>
      </section>

      <section className="flex flex-col border-t">
        <header className="flex items-center gap-2 border-b px-3 py-2">
          <h2 className="text-xs font-semibold">绑定</h2>
          <span className="text-muted-foreground text-[10px]">端口 → 端点</span>
        </header>
        <div className="max-h-56 overflow-y-auto px-3 py-1">
          {instance === undefined ? (
            <p className="text-muted-foreground py-1 text-[11px]">未选中实例。</p>
          ) : definition === undefined ? (
            <p className="text-muted-foreground py-1 text-[11px]">定义解析后可用。</p>
          ) : ports.length === 0 ? (
            <p className="text-muted-foreground py-1 text-[11px]">该 widget 没有端口。</p>
          ) : (
            ports.map(([key, port]) => (
              <BindingField
                key={`${instance.id}:${key}:${revision}`}
                instance={instance}
                portKey={key}
                port={port}
                targets={targets}
                disabled={readOnly}
                onApply={onApply}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}
