import { useEffect, useState } from 'react';
import type {
  DevicePropertyDescriptor,
  FusedInstance,
  PropertyValue,
  UnifiedDeviceManifest,
} from '@mica-js/document/fused';
import type { FirmwareProject, IFirmwareProjectProvider } from '../providers';
import { Icon } from '../parts/activity-bar-part';

interface IPropertyProps {
  readonly name: string;
  readonly descriptor: DevicePropertyDescriptor;
  readonly value: PropertyValue | undefined;
  readonly overridden: boolean;
  readonly disabled: boolean;
  readonly set: (value: PropertyValue) => void;
  readonly reset: () => void;
  readonly onError: (error: unknown) => void;
  readonly onImport: (file: File) => Promise<void>;
  readonly projects: readonly FirmwareProject[];
  readonly createProject: (() => void) | undefined;
  readonly openProject: (id: string) => void;
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
  const resource = typeof value === 'object' && value !== null ? value : undefined;
  const projectId = resource?.mode === 'project' ? resource.projectId : undefined;
  return (
    <div className="mica-wb-property">
      <label title={descriptor.description}>{descriptor.title ?? props.name}</label>
      <div className="mica-wb-property-control">
        {descriptor.type === 'boolean' ? (
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
        ) : descriptor.type === 'image' ||
          descriptor.type === 'binary' ||
          descriptor.type === 'firmware' ? (
          <div className="mica-wb-resource-control">
            {descriptor.type === 'firmware' && (
              <select
                aria-label="固件工程"
                disabled={props.disabled}
                value={projectId ?? ''}
                onChange={(event) => {
                  if (event.target.value)
                    props.set({ mode: 'project', projectId: event.target.value });
                }}
              >
                <option value="">
                  {resource !== undefined && 'src' in resource
                    ? resource.src
                    : '选择工程或导入文件'}
                </option>
                {projectId !== undefined &&
                  !props.projects.some((project) => project.id === projectId) && (
                    <option value={projectId}>{projectId}（不可用）</option>
                  )}
                {props.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
              </select>
            )}
            {descriptor.type !== 'firmware' && (
              <span className="mica-wb-resource-name">
                {resource !== undefined && 'src' in resource ? resource.src : '未设置'}
              </span>
            )}
            <label className="mica-wb-file-button" title="导入文件">
              <Icon name="folder-opened" />
              <input
                type="file"
                disabled={props.disabled}
                aria-label={`导入${descriptor.title ?? props.name}`}
                accept={
                  descriptor.type === 'firmware'
                    ? '.bin,.hex,.ihx,.elf,.axf'
                    : descriptor.type === 'image'
                      ? 'image/png,image/svg+xml'
                      : descriptor.extensions?.join(',')
                }
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) void props.onImport(file).catch(props.onError);
                  event.currentTarget.value = '';
                }}
              />
            </label>
            {props.createProject !== undefined && (
              <button
                title="新建固件工程"
                aria-label="新建固件工程"
                disabled={props.disabled}
                onClick={props.createProject}
              >
                <Icon name="add" />
              </button>
            )}
            {projectId !== undefined && (
              <button
                title="打开固件工程"
                aria-label="打开固件工程"
                onClick={() => props.openProject(projectId)}
              >
                <Icon name="go-to-file" />
              </button>
            )}
          </div>
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
        {props.overridden && (
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
  readonly projectProvider: IFirmwareProjectProvider | undefined;
  readonly onSet: (key: string, value: PropertyValue) => void;
  readonly onReset: (key: string) => void;
  readonly onImport: (key: string, file: File) => Promise<void>;
  readonly onCreate: (key: string) => void;
  readonly onOpenProject: (id: string) => void;
  readonly onError: (error: unknown) => void;
  readonly actions?: React.ReactNode;
  readonly hideHeader?: boolean;
  readonly fill?: boolean;
  readonly collapsed?: boolean;
  readonly height: number | undefined;
  readonly onToggle?: (collapsed: boolean) => void;
}) {
  const [projects, setProjects] = useState<readonly FirmwareProject[]>([]);
  useEffect(() => {
    let active = true;
    if (props.projectProvider === undefined) return;
    void props.projectProvider
      .list()
      .then((values) => {
        if (
          values.some((value) => !value.id.trim() || !value.title.trim()) ||
          new Set(values.map((value) => value.id)).size !== values.length
        )
          throw new Error('固件工程列表无效');
        if (active) setProjects(values);
      })
      .catch((error) => {
        if (active) props.onError(error);
      });
    return () => {
      active = false;
    };
  }, [props.projectProvider, props.instance]);
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
              onImport={(file) => props.onImport(name, file)}
              projects={projects}
              createProject={
                descriptor.type === 'firmware' && props.projectProvider?.create !== undefined
                  ? () => props.onCreate(name)
                  : undefined
              }
              openProject={props.onOpenProject}
            />
          ))}
        </div>
      </details>
    </section>
  );
}
