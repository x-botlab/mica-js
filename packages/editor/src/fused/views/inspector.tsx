import { useEffect, useState } from 'react';
import type {
  ConnectionNode,
  ConnectionWire,
  DevicePropertyDescriptor,
  FusedInstance,
  NetLabel,
  PropertyValue,
  UnifiedDeviceManifest,
  VoltageReference,
} from '@mica-js/document/fused';
import type { IAssetProvider } from '../providers';
import { Icon } from '../parts/activity-bar-part';
import { ResourceField } from './program';
import type { ProgramSources, ProgramTarget } from '@mica-js/sdk/fused';
import type { FusedPresentationProps } from '../runtime/protocol';

interface IPropertyProps {
  readonly name: string;
  readonly descriptor: DevicePropertyDescriptor;
  readonly value: PropertyValue | undefined;
  readonly overridden: boolean;
  readonly disabled: boolean;
  readonly set: (value: PropertyValue) => void;
  readonly reset: () => void;
  readonly onError: (error: unknown) => void;
  readonly assets: IAssetProvider | undefined;
  readonly validate: (value: PropertyValue, signal: AbortSignal) => Promise<Uint8Array | undefined>;
  readonly commitResource: (value: PropertyValue, signal: AbortSignal) => Promise<void>;
  readonly openProject: (id: string) => void;
  readonly programSources: ProgramSources | undefined;
  readonly programTarget: ProgramTarget;
  readonly packagePaths: readonly string[];
  readonly snapshot: FusedPresentationProps[string] | undefined;
}

function PropertyField(props: IPropertyProps) {
  const value = props.value;
  const descriptor = props.descriptor;
  const [draft, setDraft] = useState(typeof value === 'object' ? '' : String(value ?? ''));
  useEffect(() => setDraft(typeof value === 'object' ? '' : String(value ?? '')), [value]);
  const commit = () => {
    if (props.disabled || draft === String(value ?? '')) return;
    if (descriptor.type === 'integer' || descriptor.type === 'number') {
      const number = Number(draft);
      if (
        draft.trim() === '' ||
        !Number.isFinite(number) ||
        (descriptor.type === 'integer' && !Number.isInteger(number))
      ) {
        props.onError(
          new Error(`${props.name} 需要有效的${descriptor.type === 'integer' ? '整数' : '数值'}`),
        );
        return;
      }
      props.set(number);
    } else props.set(draft);
  };
  return (
    <div className="mica-wb-property">
      <label title={descriptor.description}>{descriptor.title ?? props.name}</label>
      <div className="mica-wb-property-control">
        {['program', 'image', 'binary', 'firmware'].includes(descriptor.type) ? (
          <ResourceField
            name={props.name}
            descriptor={descriptor}
            value={value}
            target={props.programTarget}
            sources={props.programSources}
            packagePaths={props.packagePaths}
            snapshot={props.snapshot}
            disabled={props.disabled}
            overridden={props.overridden}
            assets={props.assets}
            validate={props.validate}
            commit={props.commitResource}
            reset={props.reset}
            set={props.set}
            onOpenProject={props.openProject}
            onError={props.onError}
          />
        ) : descriptor.type === 'boolean' ? (
          <input
            type="checkbox"
            aria-label={descriptor.title ?? props.name}
            checked={value === true}
            disabled={props.disabled}
            onChange={(event) => props.set(event.target.checked)}
          />
        ) : descriptor.type === 'enum' ? (
          <select
            aria-label={descriptor.title ?? props.name}
            value={String(value ?? '')}
            disabled={props.disabled}
            onChange={(event) => props.set(event.target.value)}
          >
            {value === undefined && <option value="">未设置</option>}
            {descriptor.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label={descriptor.title ?? props.name}
            type={
              descriptor.type === 'color'
                ? 'color'
                : descriptor.type === 'number' || descriptor.type === 'integer'
                  ? 'number'
                  : 'text'
            }
            value={draft}
            min={descriptor.min}
            max={descriptor.max}
            step={descriptor.step ?? (descriptor.type === 'integer' ? 1 : 'any')}
            disabled={props.disabled}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
            }}
          />
        )}
        {props.overridden &&
          !['program', 'image', 'binary', 'firmware'].includes(descriptor.type) && (
            <button
              title="恢复默认值"
              aria-label={`恢复 ${props.name} 的默认值`}
              disabled={props.disabled}
              onClick={props.reset}
            >
              <Icon name="discard" />
            </button>
          )}
      </div>
    </div>
  );
}

/** Everything a selection can describe when it is not a device instance. */
export type IInspectorAnnotation =
  | {
      readonly kind: 'reference';
      readonly reference: VoltageReference;
      readonly endpoint: string;
    }
  | { readonly kind: 'label'; readonly label: NetLabel; readonly endpoint: string }
  | {
      readonly kind: 'wire';
      readonly wire: ConnectionWire;
      readonly from: string;
      readonly to: string;
    }
  | { readonly kind: 'node'; readonly node: ConnectionNode };

/** Text or number cell that commits on blur and Enter, restoring `Escape`. */
function CommitInput(props: {
  readonly label: string;
  readonly value: string;
  readonly numeric: boolean;
  readonly placeholder?: string;
  readonly disabled: boolean;
  readonly commit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => {
    if (props.disabled || draft === props.value) return;
    props.commit(draft);
  };
  return (
    <input
      aria-label={props.label}
      type={props.numeric ? 'number' : 'text'}
      value={draft}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(props.value);
        }
      }}
    />
  );
}

function AnnotationField(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="mica-wb-property">
      <label>{props.label}</label>
      <div className="mica-wb-property-control">{props.children}</div>
    </div>
  );
}

const REFERENCE_TITLES: Readonly<Record<'power' | 'ground' | 'constraint', string>> = {
  power: '电源端',
  ground: '接地端',
  constraint: '电压参考',
};

function AnnotationFields(props: {
  readonly annotation: IInspectorAnnotation;
  readonly disabled: boolean;
  readonly onRenameLabel: (labelId: string, name: string) => void;
  readonly onSetVoltage: (referenceId: string, voltage: number) => void;
  readonly onSetReferenceName: (referenceId: string, name: string | undefined) => void;
  readonly onSetRotation: (referenceId: string, rotation: number) => void;
  readonly onError: (error: unknown) => void;
}) {
  const annotation = props.annotation;
  if (annotation.kind === 'node')
    return (
      <dl className="mica-wb-identity">
        <dt>对象</dt>
        <dd>连接节点</dd>
        <dt>类型</dt>
        <dd>{annotation.node.kind === 'junction' ? '分支点' : '自由端点'}</dd>
        <dt>坐标</dt>
        <dd>{`${String(annotation.node.x)}, ${String(annotation.node.y)} mm`}</dd>
      </dl>
    );
  if (annotation.kind === 'wire')
    return (
      <dl className="mica-wb-identity">
        <dt>对象</dt>
        <dd>导线</dd>
        <dt>起点</dt>
        <dd>{annotation.from}</dd>
        <dt>终点</dt>
        <dd>{annotation.to}</dd>
        <dt>折点</dt>
        <dd>{String(annotation.wire.bends.length)}</dd>
      </dl>
    );
  if (annotation.kind === 'label')
    return (
      <>
        <dl className="mica-wb-identity">
          <dt>对象</dt>
          <dd>网标</dd>
          <dt>连接端</dt>
          <dd>{annotation.endpoint}</dd>
        </dl>
        <AnnotationField label="网名">
          <CommitInput
            label="网名"
            numeric={false}
            value={annotation.label.name}
            disabled={props.disabled}
            commit={(draft) => {
              const name = draft.trim();
              if (name.length === 0) {
                props.onError(new Error('网名不能为空'));
                return;
              }
              props.onRenameLabel(annotation.label.id, name);
            }}
          />
        </AnnotationField>
      </>
    );
  const reference = annotation.reference;
  const ground = reference.symbol === 'ground';
  return (
    <>
      <dl className="mica-wb-identity">
        <dt>对象</dt>
        <dd>{REFERENCE_TITLES[reference.symbol ?? 'constraint']}</dd>
        <dt>连接端</dt>
        <dd>{annotation.endpoint}</dd>
        {ground ? (
          <>
            <dt>电压</dt>
            <dd>0 V</dd>
          </>
        ) : undefined}
      </dl>
      {reference.symbol === undefined ? undefined : (
        <AnnotationField label="角度（°）">
          <CommitInput
            label="角度"
            numeric
            value={String(reference.rotation ?? 0)}
            disabled={props.disabled}
            commit={(draft) => {
              const rotation = Number(draft);
              if (draft.trim() === '' || !Number.isFinite(rotation)) {
                props.onError(new Error('角度需要有效数值'));
                return;
              }
              props.onSetRotation(reference.id, rotation);
            }}
          />
        </AnnotationField>
      )}
      {ground ? undefined : (
        <AnnotationField label="电压（V）">
          <CommitInput
            label="电压"
            numeric
            value={String(reference.voltage)}
            disabled={props.disabled}
            commit={(draft) => {
              const voltage = Number(draft);
              if (draft.trim() === '' || !Number.isFinite(voltage)) {
                props.onError(new Error('电压需要有效数值'));
                return;
              }
              props.onSetVoltage(reference.id, voltage);
            }}
          />
        </AnnotationField>
      )}
      {reference.symbol === 'power' ? (
        <AnnotationField label="网名">
          <CommitInput
            label="网名"
            numeric={false}
            value={reference.label?.name ?? ''}
            placeholder="未命名"
            disabled={props.disabled}
            commit={(draft) => {
              const name = draft.trim();
              props.onSetReferenceName(reference.id, name.length === 0 ? undefined : name);
            }}
          />
        </AnnotationField>
      ) : undefined}
    </>
  );
}

export function InspectorView(props: {
  readonly instance: FusedInstance | undefined;
  readonly manifest: UnifiedDeviceManifest | undefined;
  /** Selected terminal, net label, wire or node when no device instance is selected. */
  readonly annotation?: IInspectorAnnotation | undefined;
  readonly selectionCount: number;
  readonly disabled: boolean;
  readonly assets?: IAssetProvider | undefined;
  readonly programs?: ProgramSources | undefined;
  readonly packagePaths?: readonly string[];
  readonly snapshots?: FusedPresentationProps | undefined;
  readonly onSet: (key: string, value: PropertyValue) => void;
  readonly onReset: (key: string) => void;
  readonly onRenameLabel: (labelId: string, name: string) => void;
  readonly onSetVoltage: (referenceId: string, voltage: number) => void;
  readonly onSetReferenceName: (referenceId: string, name: string | undefined) => void;
  readonly onSetRotation: (referenceId: string, rotation: number) => void;
  readonly onValidate: (
    key: string,
    value: PropertyValue,
    signal: AbortSignal,
  ) => Promise<Uint8Array | undefined>;
  readonly onCommit: (key: string, value: PropertyValue, signal: AbortSignal) => Promise<void>;
  readonly onOpenProject: (id: string) => void;
  readonly onError: (error: unknown) => void;
  readonly actions?: React.ReactNode;
  readonly hideHeader?: boolean;
  readonly fill?: boolean;
  readonly collapsed?: boolean;
  readonly height: number | undefined;
  readonly onToggle?: (collapsed: boolean) => void;
}) {
  const header = (
    <summary
      className="mica-wb-panel-title"
      style={props.hideHeader ? { display: 'none' } : undefined}
    >
      <span className="mica-wb-panel-caption">
        <Icon name={props.collapsed ? 'chevron-right' : 'chevron-down'} />
        属性
      </span>
      <span
        className="mica-wb-panel-actions"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {props.actions}
      </span>
    </summary>
  );
  const toggled = (event: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!props.hideHeader && event.currentTarget.open === props.collapsed)
      props.onToggle?.(!event.currentTarget.open);
  };
  if (props.instance === undefined || props.manifest === undefined)
    return (
      <section
        className={`mica-wb-inspector${props.fill && (props.hideHeader || !props.collapsed) ? ' is-fill' : ''}`}
        aria-label="器件属性"
        data-view-id="mica.properties"
      >
        <details open={props.hideHeader || !props.collapsed} onToggle={toggled}>
          {header}
          {props.annotation === undefined ? (
            <p className="mica-wb-empty">
              {props.selectionCount > 1
                ? `已选择 ${props.selectionCount} 个对象`
                : '选择器件以查看其属性'}
            </p>
          ) : (
            <div
              className="mica-wb-property-fields"
              style={{ height: props.fill ? undefined : props.height }}
            >
              <AnnotationFields
                annotation={props.annotation}
                disabled={props.disabled}
                onRenameLabel={props.onRenameLabel}
                onSetVoltage={props.onSetVoltage}
                onSetReferenceName={props.onSetReferenceName}
                onSetRotation={props.onSetRotation}
                onError={props.onError}
              />
            </div>
          )}
        </details>
      </section>
    );
  const properties = Object.entries(props.manifest.properties ?? {}).sort(
    ([a, x], [b, y]) => (x.order ?? 0) - (y.order ?? 0) || a.localeCompare(b),
  );
  return (
    <section
      className={`mica-wb-inspector${props.fill && (props.hideHeader || !props.collapsed) ? ' is-fill' : ''}`}
      aria-label="器件属性"
      data-view-id="mica.properties"
    >
      <details open={props.hideHeader || !props.collapsed} onToggle={toggled}>
        {header}
        <div
          className="mica-wb-property-fields"
          style={{ height: props.fill ? undefined : props.height }}
        >
          <dl className="mica-wb-identity">
            <dt>位号</dt>
            <dd>{props.instance.designator ?? '—'}</dd>
            <dt>器件</dt>
            <dd>{props.manifest.displayName}</dd>
          </dl>
          {properties.map(([name, descriptor]) => (
            <PropertyField
              key={`${props.instance?.id}:${name}`}
              name={name}
              descriptor={descriptor}
              programSources={props.programs}
              programTarget={{
                deviceId: props.instance!.device,
                property: name,
                loader: descriptor.type === 'program' ? descriptor.loader! : 'memory',
              }}
              packagePaths={props.packagePaths ?? []}
              snapshot={props.snapshots?.[name]}
              value={
                Object.hasOwn(props.instance?.properties ?? {}, name)
                  ? props.instance?.properties?.[name]
                  : descriptor.default
              }
              overridden={Object.hasOwn(props.instance?.properties ?? {}, name)}
              disabled={props.disabled}
              set={(value) => props.onSet(name, value)}
              reset={() => props.onReset(name)}
              onError={props.onError}
              assets={props.assets}
              validate={(value, signal) => props.onValidate(name, value, signal)}
              commitResource={(value, signal) => props.onCommit(name, value, signal)}
              openProject={props.onOpenProject}
            />
          ))}
        </div>
      </details>
    </section>
  );
}
