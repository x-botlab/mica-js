import { useEffect, useState } from 'react';
import type {
  DevicePropertyDescriptor,
  FusedInstance,
  PropertyValue,
  UnifiedDeviceManifest,
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

export function InspectorView(props: {
  readonly instance: FusedInstance | undefined;
  readonly manifest: UnifiedDeviceManifest | undefined;
  readonly selectionCount: number;
  readonly disabled: boolean;
  readonly assets?: IAssetProvider | undefined;
  readonly programs?: ProgramSources | undefined;
  readonly packagePaths?: readonly string[];
  readonly snapshots?: FusedPresentationProps | undefined;
  readonly onSet: (key: string, value: PropertyValue) => void;
  readonly onReset: (key: string) => void;
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
          <p className="mica-wb-empty">
            {props.selectionCount > 1
              ? `已选择 ${props.selectionCount} 个对象`
              : '选择器件以查看其属性'}
          </p>
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
