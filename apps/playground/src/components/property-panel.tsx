import type {
  Inspector,
  PropertyField,
  SymbolInspector,
  WireInspector,
} from '@mica-js/schematic-editor';
import type { PropertyValue } from '@mica-js/core/schematic';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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

function PropertyInput({ field, disabled, onChange, onReset }: PropertyInputProps) {
  const inherited = field.value === undefined;
  const placeholder = inherited
    ? field.defaultValue === undefined
      ? '未设置'
      : `${String(field.defaultValue)}（默认）`
    : undefined;

  if (field.type === 'boolean') {
    const checked = field.value === true || (inherited && field.defaultValue === true);
    return (
      <div className="grid grid-cols-[56px_1fr_auto] items-center gap-2 text-[11px]">
        <span className="text-muted-foreground">{field.key}</span>
        <input
          type="checkbox"
          className="accent-primary size-3.5"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <ResetButton inherited={inherited} disabled={disabled} onReset={onReset} />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[56px_1fr_auto] items-center gap-2 text-[11px]">
      <span className="text-muted-foreground">{field.key}</span>
      <Input
        type={field.type === 'number' ? 'number' : 'text'}
        key={`${field.key}:${String(field.value)}`}
        defaultValue={field.value === undefined ? '' : String(field.value)}
        placeholder={placeholder}
        disabled={disabled}
        onBlur={(event) => {
          const input = event.currentTarget;
          const text = input.value.trim();
          const authoritative = field.value === undefined ? '' : String(field.value);
          if (text === '') {
            if (!inherited) {
              onReset();
            }
            return;
          }
          if (field.type === 'number') {
            const parsed = Number(text);
            if (!Number.isFinite(parsed)) {
              input.value = authoritative;
              return;
            }
            onChange(parsed);
          } else {
            onChange(text);
          }
          // Accepted edits re-render with the new value; rejected ones fall back.
          input.value = authoritative;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
        }}
      />
      <ResetButton inherited={inherited} disabled={disabled} onReset={onReset} />
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
      title="恢复默认"
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
      {inspector.properties.length === 0 ? (
        <p className="text-muted-foreground mt-1 text-[11px]">该器件未声明可编辑属性</p>
      ) : (
        <>
          <div className="text-muted-foreground mt-1 text-[10px] tracking-wide uppercase">属性</div>
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
      <div className="mb-1 text-xs font-medium">
        导线 <span className="text-muted-foreground font-mono text-[10px]">{inspector.id}</span>
      </div>
      <Row label="网络">{inspector.netName ?? '未命名'}</Row>
      <Row label="端点数">{String(inspector.points.length)}</Row>
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
 * this is what a host is expected to build on top of `state.inspector` and the controller.
 */
export function PropertyPanel(props: PropertyPanelProps) {
  const { inspector, readOnly } = props;
  return (
    <Card className="gap-2 py-3">
      <CardHeader>
        <CardTitle>属性</CardTitle>
        <CardDescription>读取 state.inspector，写入走 controller</CardDescription>
      </CardHeader>
      <CardContent>
        {inspector === undefined ? (
          <p className="text-muted-foreground text-[11px]">选择器件或导线后在此查看与编辑</p>
        ) : inspector.kind === 'wire' ? (
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
