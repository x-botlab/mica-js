import type {
  Inspector,
  PropertyField,
  SymbolInspector,
  WireInspector,
} from '@mica-js/schematic-editor';
import { useEffect, useState } from 'react';
import type { PropertyValue } from '@mica-js/core/schematic';
import type { AssetMode } from '@mica-js/core/schematic';
import { base64Error, isAssetReference } from '@mica-js/core/schematic';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const ROLE_TITLES: Readonly<Record<SymbolInspector['role'], string>> = {
  component: '器件',
  'net-label': '网络标签',
  power: '电源',
  ground: '地',
  text: '文本',
};

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${Number((value / (1024 * 1024)).toFixed(1))} MiB`;
  }
  if (value >= 1024) {
    return `${Number((value / 1024).toFixed(1))} KiB`;
  }
  return `${value} B`;
}

function formatPoint(point: { readonly x: number; readonly y: number } | undefined): string {
  return point === undefined ? '—' : `${formatNumber(point.x)}, ${formatNumber(point.y)}`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[56px_1fr] items-center gap-2 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-mono">{children}</span>
    </div>
  );
}

interface FieldProps {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onCommit: (next: string) => void;
}

/** Text field that only commits on blur/Enter and ignores empty or unchanged input. */
function TextField({ label, value, disabled, onCommit }: FieldProps) {
  return (
    <label className="grid grid-cols-[56px_1fr] items-center gap-2 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <Input
        defaultValue={value}
        key={value}
        disabled={disabled}
        onBlur={(event) => {
          const input = event.currentTarget;
          const next = input.value.trim();
          if (next === '' || next === value) {
            input.value = value;
            return;
          }
          onCommit(next);
          // Accepted edits re-render with the new value; rejected ones fall back to this one.
          input.value = value;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

interface PropertyInputProps {
  readonly field: PropertyField;
  readonly disabled: boolean;
  readonly onChange: (value: PropertyValue) => void;
  readonly onReset: () => void;
}

function assetText(value: PropertyValue | undefined): string {
  if (value === undefined) {
    return '未声明';
  }
  if (value === null) {
    return 'null';
  }
  if (isAssetReference(value)) {
    return `${value.mode}:${value.src}`;
  }
  return String(value);
}

/** One property row: title, the control matching `field.type`, and a reset-to-default button. */
function PropertyInput({ field, disabled, onChange, onReset }: PropertyInputProps) {
  const inherited = field.value === undefined;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-dashed px-1.5 py-1">
      <div className="flex items-center gap-1">
        <span className="truncate text-[11px]">{field.title ?? field.key}</span>
        <ResetButton inherited={inherited} disabled={disabled} onReset={onReset} />
      </div>
      <PropertyControl field={field} disabled={disabled} onChange={onChange} onReset={onReset} />
    </div>
  );
}

function PropertyControl({ field, disabled, onChange, onReset }: PropertyInputProps) {
  switch (field.type) {
    case 'boolean':
      return (
        <BooleanControl field={field} disabled={disabled} onChange={onChange} onReset={onReset} />
      );
    case 'integer':
    case 'number':
      return (
        <NumberControl field={field} disabled={disabled} onChange={onChange} onReset={onReset} />
      );
    case 'color':
      return (
        <ColorControl field={field} disabled={disabled} onChange={onChange} onReset={onReset} />
      );
    case 'enum':
      return (
        <EnumControl field={field} disabled={disabled} onChange={onChange} onReset={onReset} />
      );
    case 'image':
    case 'binary':
      return (
        <AssetControl field={field} disabled={disabled} onChange={onChange} onReset={onReset} />
      );
    case 'string':
      return (
        <StringControl field={field} disabled={disabled} onChange={onChange} onReset={onReset} />
      );
  }
}

function commitOnEnter(event: React.KeyboardEvent<HTMLInputElement>): void {
  if (event.key === 'Enter') {
    event.currentTarget.blur();
  }
}

function StringControl({ field, disabled, onChange, onReset }: PropertyInputProps) {
  const inherited = field.value === undefined;
  const current = typeof field.value === 'string' ? field.value : '';
  return (
    <Input
      key={`${field.key}:${current}`}
      aria-label={field.key}
      defaultValue={current}
      placeholder={inherited ? `默认：${assetText(field.defaultValue)}` : undefined}
      maxLength={field.maxLength}
      disabled={disabled}
      onBlur={(event) => {
        const input = event.currentTarget;
        const next = input.value;
        if (next === '') {
          if (!inherited) {
            onReset();
          }
          return;
        }
        if (next === current) {
          return;
        }
        onChange(next);
        input.value = current;
      }}
      onKeyDown={commitOnEnter}
    />
  );
}

function NumberControl({ field, disabled, onChange, onReset }: PropertyInputProps) {
  const inherited = field.value === undefined;
  const current = typeof field.value === 'number' ? String(field.value) : '';
  return (
    <div className="flex items-center gap-1">
      <Input
        type="number"
        key={`${field.key}:${current}`}
        aria-label={field.key}
        defaultValue={current}
        placeholder={inherited ? `默认：${assetText(field.defaultValue)}` : undefined}
        min={field.min ?? field.exclusiveMin}
        max={field.max}
        step={field.step ?? (field.type === 'integer' ? 1 : 'any')}
        disabled={disabled}
        onBlur={(event) => {
          const input = event.currentTarget;
          const text = input.value.trim();
          if (text === '') {
            if (!inherited) {
              onReset();
            }
            return;
          }
          const parsed = Number(text);
          if (
            !Number.isFinite(parsed) ||
            (field.type === 'integer' && !Number.isSafeInteger(parsed))
          ) {
            input.value = current;
            return;
          }
          if (String(parsed) === current) {
            return;
          }
          onChange(parsed);
          input.value = current;
        }}
        onKeyDown={commitOnEnter}
      />
      {field.unit === undefined ? null : (
        <span className="text-muted-foreground text-[10px]">{field.unit}</span>
      )}
    </div>
  );
}

function BooleanControl({ field, disabled, onChange }: PropertyInputProps) {
  const inherited = field.value === undefined;
  const checked = field.value === true || (inherited && field.defaultValue === true);
  return (
    <label className="flex items-center gap-2 text-[11px]">
      <input
        type="checkbox"
        aria-label={field.key}
        className="accent-primary size-3.5"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="text-muted-foreground">
        {inherited ? `默认：${checked ? 'true' : 'false'}` : checked ? 'true' : 'false'}
      </span>
    </label>
  );
}

function ColorControl({ field, disabled, onChange, onReset }: PropertyInputProps) {
  const inherited = field.value === undefined;
  const current =
    typeof field.value === 'string'
      ? field.value.toUpperCase()
      : typeof field.defaultValue === 'string'
        ? field.defaultValue.toUpperCase()
        : '#000000';
  const base = current.length === 9 ? current.slice(0, 7) : current;
  return (
    <div className="flex items-center gap-1">
      <input
        type="color"
        aria-label={field.key}
        className="bg-background h-6 w-8 rounded border"
        value={base}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            field.alpha === true
              ? `${event.target.value.toUpperCase()}${current.length === 9 ? current.slice(7) : 'FF'}`
              : event.target.value.toUpperCase(),
          )
        }
      />
      {field.alpha === true ? (
        <Input
          key={`${field.key}:${current}`}
          aria-label={`${field.key} hex`}
          defaultValue={current}
          disabled={disabled}
          className="font-mono text-[10px]"
          onBlur={(event) => {
            const input = event.currentTarget;
            const next = input.value.trim().toUpperCase();
            if (next === '') {
              if (!inherited) {
                onReset();
              }
              return;
            }
            if (next !== current) {
              onChange(next);
            }
            input.value = current;
          }}
          onKeyDown={commitOnEnter}
        />
      ) : (
        <span className="font-mono text-[10px]">{base}</span>
      )}
    </div>
  );
}

function EnumControl({ field, disabled, onChange, onReset }: PropertyInputProps) {
  const inherited = field.value === undefined;
  const options = field.options ?? [];
  return (
    <select
      aria-label={field.key}
      className="bg-background h-7 w-full rounded-md border px-1.5 text-[11px]"
      value={inherited ? '' : String(field.value)}
      disabled={disabled}
      onChange={(event) => {
        const next = event.target.value;
        if (next === '') {
          onReset();
          return;
        }
        onChange(next);
      }}
    >
      <option value="">{inherited ? `默认：${assetText(field.defaultValue)}` : '继承默认'}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function AssetControl({ field, disabled, onChange, onReset }: PropertyInputProps) {
  const inherited = field.value === undefined;
  const override = isAssetReference(field.value) ? field.value : undefined;
  const fallback = isAssetReference(field.defaultValue) ? field.defaultValue : undefined;
  const shown = override ?? fallback;
  const declaredMode = shown?.mode ?? 'file';
  const src = shown?.src ?? '';
  // Mode is edited locally: switching it must not re-reference the path of the previous mode.
  const [mode, setMode] = useState<AssetMode>(declaredMode);
  useEffect(() => setMode(declaredMode), [declaredMode, field.key]);
  const commit = (nextSrc: string, nextMode: AssetMode): void => {
    if (nextSrc.length === 0) {
      return;
    }
    onChange({ src: nextSrc, mode: nextMode });
  };
  const preview =
    field.type === 'image' && src.length > 0
      ? mode === 'inline'
        ? base64Error(src) === undefined
          ? `data:image/*;base64,${src}`
          : undefined
        : mode === 'file'
          ? `/${src}`
          : undefined
      : undefined;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <select
          aria-label={`${field.key} mode`}
          className="bg-background h-6 rounded-md border px-1 font-mono text-[10px]"
          value={mode}
          disabled={disabled}
          onChange={(event) => setMode(event.target.value as AssetMode)}
        >
          <option value="file">file</option>
          <option value="inline">inline</option>
          <option value="store">store</option>
        </select>
      </div>
      <Input
        key={`${field.key}:${mode}:${src}`}
        aria-label={field.key}
        defaultValue={src}
        disabled={disabled}
        className="font-mono text-[10px]"
        onBlur={(event) => {
          const input = event.currentTarget;
          const next = input.value.trim();
          if (next === '') {
            if (!inherited) {
              onReset();
            }
            return;
          }
          if (next !== src) {
            commit(next, mode);
          }
          input.value = src;
        }}
        onKeyDown={commitOnEnter}
      />
      {preview === undefined ? null : (
        <img
          src={preview}
          alt={field.key}
          className="bg-background h-14 w-full rounded border object-contain"
        />
      )}
      <div className="text-muted-foreground flex items-center gap-2 text-[10px]">
        {mode === 'inline' ? (
          <span>{formatBytes(Math.floor((src.length * 3) / 4))}（内联）</span>
        ) : null}
        {field.maxBytes === undefined ? null : <span>≤ {formatBytes(field.maxBytes)}</span>}
        {field.maxPixels === undefined ? null : <span>≤ {field.maxPixels} px</span>}
      </div>
    </div>
  );
}

function ResetButton({
  inherited,
  disabled,
  onReset,
}: {
  readonly inherited: boolean;
  readonly disabled: boolean;
  readonly onReset: () => void;
}) {
  return (
    <button
      type="button"
      aria-label="恢复默认"
      disabled={disabled || inherited}
      onClick={onReset}
      className={cn(
        'text-muted-foreground hover:text-foreground h-6 w-6 rounded text-[11px] disabled:opacity-30',
      )}
    >
      ↺
    </button>
  );
}

function SymbolSection({
  inspector,
  readOnly,
  onPropertyChange,
  onPropertyReset,
  onDesignatorChange,
  onNetChange,
}: {
  readonly inspector: SymbolInspector;
  readonly readOnly: boolean;
} & Pick<
  PropertyPanelProps,
  'onPropertyChange' | 'onPropertyReset' | 'onDesignatorChange' | 'onNetChange'
>) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="mb-1 text-xs font-medium">
        {ROLE_TITLES[inspector.role]}{' '}
        <span className="text-muted-foreground font-mono text-[10px]">
          {inspector.designator ?? inspector.net ?? inspector.id}
        </span>
      </div>
      {inspector.designator !== undefined ? (
        <TextField
          label="位号"
          value={inspector.designator}
          disabled={readOnly}
          onCommit={(next) => onDesignatorChange(inspector.id, next)}
        />
      ) : null}
      {inspector.net !== undefined ? (
        <TextField
          label="网名"
          value={inspector.net}
          disabled={readOnly}
          onCommit={(next) => onNetChange(inspector.id, next)}
        />
      ) : null}
      <Row label="器件">{inspector.device}</Row>
      <Row label="名称">{inspector.name ?? '—'}</Row>
      <Row label="位置">{`${formatNumber(inspector.x)}, ${formatNumber(inspector.y)}`}</Row>
      <Row label="旋转">{`${formatNumber(inspector.rotation)}°`}</Row>
      {inspector.properties.length === 0 ? null : (
        <>
          {inspector.properties.map((field) => (
            <PropertyInput
              key={field.key}
              field={field}
              disabled={readOnly}
              onChange={(value) => onPropertyChange(inspector.id, field.key, value)}
              onReset={() => onPropertyReset(inspector.id, field.key)}
            />
          ))}
        </>
      )}
    </div>
  );
}

function WireSection({ inspector }: { readonly inspector: WireInspector }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="mb-1 text-xs font-medium">导线</div>
      <Row label="网络">{inspector.netName ?? '未命名'}</Row>
      <Row label="起点">{formatPoint(inspector.points[0])}</Row>
      <Row label="终点">{formatPoint(inspector.points[inspector.points.length - 1])}</Row>
    </div>
  );
}

export interface PropertyPanelProps {
  readonly inspector: Inspector;
  readonly readOnly: boolean;
  readonly onPropertyChange: (symbolId: string, key: string, value: PropertyValue) => void;
  readonly onPropertyReset: (symbolId: string, key: string) => void;
  readonly onDesignatorChange: (symbolId: string, next: string) => void;
  readonly onNetChange: (symbolId: string, next: string) => void;
}

/**
 * Reference host implementation of the inspector column: the editor ships no property UI, so
 * this is what a host is expected to build on top of `state.inspector` and the document model.
 */
export function PropertyPanel(props: PropertyPanelProps) {
  const { inspector, readOnly } = props;
  return (
    <Card className="gap-2 py-3">
      <CardHeader>
        <CardTitle>属性</CardTitle>
      </CardHeader>
      <CardContent>
        {inspector === undefined ? null : inspector.kind === 'wire' ? (
          <WireSection inspector={inspector} />
        ) : (
          <SymbolSection
            inspector={inspector}
            readOnly={readOnly}
            onPropertyChange={props.onPropertyChange}
            onPropertyReset={props.onPropertyReset}
            onDesignatorChange={props.onDesignatorChange}
            onNetChange={props.onNetChange}
          />
        )}
      </CardContent>
    </Card>
  );
}
