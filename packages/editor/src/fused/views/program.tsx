import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { DevicePropertyDescriptor, PropertyValue } from '@mica-js/document/fused';
import type { ProgramProject, ProgramSources, ProgramTarget } from '@mica-js/sdk/fused';
import type { IAssetProvider } from '../providers';
import type { FusedPresentationValue } from '../runtime/protocol';
import { Icon } from '../parts/activity-bar-part';

export function programPackageCandidates(
  paths: readonly string[],
  loader: ProgramTarget['loader'],
  formats: readonly string[] = [],
): readonly string[] {
  if (loader === 'memory')
    return paths
      .filter((path) => path.startsWith('assets/') && formats.includes(programFormat(path) ?? ''))
      .sort();
  const directories = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith('assets/')) continue;
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  return [...directories].sort();
}

export function programFormat(path: string): 'bin' | 'hex' | 'elf' | undefined {
  const ext = path.split('.').at(-1)?.toLowerCase();
  return ext === 'bin'
    ? 'bin'
    : ext === 'hex' || ext === 'ihx'
      ? 'hex'
      : ext === 'elf' || ext === 'axf'
        ? 'elf'
        : undefined;
}

export function validateProgramProjects(
  values: readonly ProgramProject[],
): readonly ProgramProject[] {
  if (
    !Array.isArray(values) ||
    values.some(
      (value) =>
        !value ||
        typeof value.id !== 'string' ||
        !value.id.trim() ||
        typeof value.title !== 'string' ||
        !value.title.trim(),
    ) ||
    new Set(values.map((value) => value.id)).size !== values.length
  )
    throw new Error('program/project-selection-failed: 项目信息无效');
  return values;
}

function ResourcePopover(props: {
  readonly id: string;
  readonly anchor: RefObject<HTMLButtonElement | null>;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly label: string;
  readonly className: string;
  readonly children: ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const popup = element.current;
    const anchor = props.anchor.current;
    if (!props.open || popup === null || anchor === null) return;
    popup.showPopover();
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const width = popup.offsetWidth;
      const height = popup.offsetHeight;
      popup.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
      popup.style.top = `${Math.max(8, Math.min(rect.bottom + 4 + height <= window.innerHeight - 8 ? rect.bottom + 4 : rect.top - height - 4, window.innerHeight - height - 8))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(popup);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [props.open, props.anchor]);
  return props.open ? (
    <div
      id={props.id}
      ref={element}
      popover="auto"
      className={`mica-wb-resource-popover ${props.className}`}
      aria-label={props.label}
      onToggle={(event) => {
        if (!event.currentTarget.matches(':popover-open')) props.onClose();
      }}
    >
      {props.children}
    </div>
  ) : null;
}

export function ResourceField(props: {
  readonly name: string;
  readonly descriptor: DevicePropertyDescriptor;
  readonly value: PropertyValue | undefined;
  readonly overridden: boolean;
  readonly target: ProgramTarget;
  readonly sources: ProgramSources | undefined;
  readonly assets: IAssetProvider | undefined;
  readonly packagePaths: readonly string[];
  readonly snapshot: FusedPresentationValue | undefined;
  readonly disabled: boolean;
  readonly set: (value: PropertyValue) => void;
  readonly reset: () => void;
  readonly validate: (value: PropertyValue, signal: AbortSignal) => Promise<Uint8Array | undefined>;
  readonly commit: (value: PropertyValue, signal: AbortSignal) => Promise<void>;
  readonly onOpenProject: (id: string) => void;
  readonly onError: (error: unknown) => void;
}) {
  const { descriptor, target, sources } = props;
  const reference =
    props.value !== null && typeof props.value === 'object' ? props.value : undefined;
  const [menu, setMenu] = useState(false);
  const [packagePicker, setPackagePicker] = useState(false);
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [projectFormat, setProjectFormat] = useState<string>();
  const [address, setAddress] = useState('');
  const [preview, setPreview] = useState<string>();
  const menuId = useId();
  const detailsId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const pending = useRef<AbortController | undefined>(undefined);
  const retryChoice = useRef<
    ((signal: AbortSignal) => Promise<PropertyValue | undefined>) | undefined
  >(undefined);
  const signature = JSON.stringify([target, props.value]);
  useEffect(() => {
    pending.current?.abort();
    setBusy(false);
    setError('');
    setMenu(false);
    setPackagePicker(false);
    retryChoice.current = undefined;
    return () => {
      pending.current?.abort();
    };
  }, [signature, props.disabled, sources, props.assets]);
  const fail = (cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
    props.onError(cause);
  };
  const perform = async (choose: (signal: AbortSignal) => Promise<PropertyValue | undefined>) => {
    if (props.disabled || busy) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setMenu(false);
    setBusy(true);
    setError('');
    retryChoice.current = choose;
    try {
      const value = await choose(controller.signal);
      if (value === undefined || controller.signal.aborted) return;
      retryChoice.current = async () => value;
      await props.validate(value, controller.signal);
      if (controller.signal.aborted) return;
      await props.commit(value, controller.signal);
      setPackagePicker(false);
    } catch (cause) {
      if (!controller.signal.aborted) fail(cause);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const program = descriptor.type === 'program';
  const memory = target.loader === 'memory';
  const sourceName = reference?.mode === 'package' ? reference.src : reference?.name;
  const name = reference?.mode === 'project' ? (reference.name ?? reference.projectId) : sourceName;
  const source =
    reference?.mode === 'asset'
      ? '资产库'
      : reference?.mode === 'project'
        ? '项目'
        : reference?.mode === 'package'
          ? '内置资源'
          : '';
  const sourceIcon =
    reference?.mode === 'asset' ? 'cloud' : reference?.mode === 'project' ? 'project' : 'package';
  const hasDetails = (program && memory) || (!program && reference?.mode === 'asset');
  const detailsTitle = program ? '装载设置' : '资源详情';
  useEffect(() => {
    setPreview(undefined);
    if (descriptor.type !== 'image' || !reference) return;
    const controller = new AbortController();
    let url: string | undefined;
    void props
      .validate(reference, controller.signal)
      .then((bytes) => {
        if (controller.signal.aborted || bytes === undefined) return;
        const type = sourceName?.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png';
        url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type }));
        setPreview(url);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) fail(cause);
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [signature, props.assets, retry]);
  const candidates = program
    ? programPackageCandidates(props.packagePaths, target.loader, descriptor.formats)
    : props.packagePaths
        .filter(
          (path) =>
            path.startsWith('assets/') &&
            (descriptor.type === 'image'
              ? /\.(png|svg)$/i.test(path)
              : descriptor.type === 'firmware'
                ? programFormat(path) !== undefined
                : !descriptor.extensions?.length ||
                  descriptor.extensions.some((ext) =>
                    path.toLowerCase().endsWith(ext.toLowerCase()),
                  )),
        )
        .sort();
  const format = reference?.mode === 'project' ? projectFormat : programFormat(sourceName ?? '');
  const defaults = program ? descriptor.defaults : undefined;
  const selectedSpace =
    reference && 'addressSpace' in reference
      ? (reference.addressSpace ?? defaults?.addressSpace)
      : defaults?.addressSpace;
  const loadAddress =
    reference && 'loadAddress' in reference
      ? (reference.loadAddress ?? defaults?.loadAddress)
      : defaults?.loadAddress;
  const spaces = descriptor.addressSpaces ?? {};
  useEffect(
    () => setAddress(loadAddress === undefined ? '' : `0x${loadAddress.toString(16)}`),
    [loadAddress, signature],
  );
  useEffect(() => {
    setProjectFormat(undefined);
    if (!details || reference?.mode !== 'project' || !sources?.projects) return;
    const controller = new AbortController();
    void sources.projects
      .resolve(reference.projectId, target, controller.signal)
      .then((artifact) => {
        if (controller.signal.aborted) return;
        if (artifact.kind !== target.loader) throw new Error('program/loader-mismatch');
        setProjectFormat(artifact.kind === 'memory' ? artifact.format : undefined);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) fail(cause);
      });
    return () => controller.abort();
  }, [details, signature, sources, retry]);
  const validAddress = (space: string, value: number) => {
    const range = spaces[space];
    return (
      range &&
      Number.isSafeInteger(value) &&
      value >= range.start &&
      value < range.start + range.size
    );
  };
  const saveAddress = () => {
    if (props.disabled || !reference || format !== 'bin') return;
    const value = /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(address.trim()) ? Number(address) : NaN;
    if (!selectedSpace || !validAddress(selectedSpace, value)) {
      fail(new Error('program/out-of-range: 装载地址不在空间范围内'));
      return;
    }
    void perform(async () => ({ ...reference, loadAddress: value }));
  };
  const snapshot = props.snapshot;
  return (
    <div
      className="mica-wb-program-control"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          if (menu) menuButton.current?.focus();
          else if (details) detailsButton.current?.focus();
          setMenu(false);
          setDetails(false);
          setPackagePicker(false);
        }
      }}
    >
      <div className="mica-wb-resource-control">
        {preview && <img className="mica-wb-resource-preview" src={preview} alt="" />}
        <div className="mica-wb-resource-summary">
          {source && (
            <span className="mica-wb-resource-source" title={source} aria-label={source}>
              <Icon name={sourceIcon} />
            </span>
          )}
          <span className="mica-wb-resource-name" title={name}>
            {name ?? '未设置'}
          </span>
          {source && !props.overridden && <small>默认</small>}
        </div>
        <button
          ref={menuButton}
          className="mica-wb-resource-action"
          aria-label={`${name ? '更换' : '选择'}${descriptor.title ?? props.name}来源`}
          title={`${name ? '更换' : '选择'}来源`}
          aria-controls={menuId}
          aria-expanded={menu}
          disabled={props.disabled || busy}
          onClick={() => setMenu(!menu)}
        >
          <Icon name="chevron-down" />
        </button>
        {hasDetails && (
          <button
            ref={detailsButton}
            className="mica-wb-resource-action"
            aria-label={detailsTitle}
            title={detailsTitle}
            aria-controls={detailsId}
            aria-expanded={details}
            onClick={() => setDetails(!details)}
          >
            <Icon name={program ? 'settings-gear' : 'info'} />
          </button>
        )}
        {reference?.mode === 'project' && (
          <button
            title="打开项目"
            aria-label="打开项目"
            onClick={() => props.onOpenProject(reference.projectId)}
          >
            <Icon name="go-to-file" />
          </button>
        )}
      </div>
      <ResourcePopover
        id={menuId}
        anchor={menuButton}
        open={menu}
        onClose={() => setMenu(false)}
        className="mica-wb-resource-menu"
        label="资源来源"
      >
        <button
          disabled={!props.assets}
          onClick={() =>
            void perform(async (signal) => {
              const asset = await props.assets!.select({
                kind:
                  program || descriptor.type === 'firmware'
                    ? 'program'
                    : descriptor.type === 'image'
                      ? 'image'
                      : 'binary',
                ...(program
                  ? { formats: memory ? descriptor.formats : ['zip'] }
                  : descriptor.type === 'binary' && descriptor.extensions
                    ? { formats: descriptor.extensions.map((ext) => ext.slice(1)) }
                    : descriptor.type === 'firmware'
                      ? { formats: ['bin', 'hex', 'elf'] }
                      : {}),
                signal,
              });
              if (asset === undefined) return undefined;
              if (
                typeof asset.id !== 'string' ||
                !asset.id.trim() ||
                typeof asset.name !== 'string' ||
                !asset.name.trim()
              )
                throw new Error('asset/invalid-selection: 资产信息无效');
              return { mode: 'asset', assetId: asset.id, name: asset.name };
            })
          }
        >
          从资产库选择…
        </button>
        {program && (
          <button
            disabled={!sources?.projects?.select}
            onClick={() =>
              void perform(async (signal) => {
                const project = await sources!.projects!.select!(
                  { ...target, templateIds: [...(descriptor.templates ?? [])] },
                  signal,
                );
                if (project === undefined) return undefined;
                validateProgramProjects([project]);
                return { mode: 'project', projectId: project.id, name: project.title };
              })
            }
          >
            从项目选择…
          </button>
        )}
        <button
          onClick={() => {
            setMenu(false);
            setPackagePicker(true);
          }}
        >
          从内置资源选择…
        </button>
        {props.overridden && descriptor.default !== undefined && (
          <button
            onClick={() => {
              setMenu(false);
              props.reset();
            }}
          >
            恢复默认
          </button>
        )}
        {descriptor.nullable && props.value !== null && (
          <button
            onClick={() => {
              setMenu(false);
              props.set(null);
            }}
          >
            清除
          </button>
        )}
      </ResourcePopover>
      {packagePicker && (
        <div className="mica-wb-resource-control">
          <select
            aria-label="内置资源"
            disabled={busy || props.disabled}
            value=""
            onChange={(event) => {
              const src = event.target.value;
              if (src) void perform(async () => ({ mode: 'package', src }));
            }}
          >
            <option value="">选择内置资源</option>
            {candidates.map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </select>
          {!candidates.length && <span>没有匹配的内置资源</span>}
          <button disabled={busy} onClick={() => setPackagePicker(false)}>
            取消
          </button>
        </div>
      )}
      {busy && <span role="status">选择／校验中…</span>}
      {error && (
        <div role="alert">
          {error}
          <button
            disabled={busy}
            onClick={() => {
              setError('');
              setRetry((value) => value + 1);
              if (!props.disabled && retryChoice.current) void perform(retryChoice.current);
            }}
          >
            重试
          </button>
        </div>
      )}
      <ResourcePopover
        id={detailsId}
        anchor={detailsButton}
        open={details && hasDetails}
        onClose={() => setDetails(false)}
        className="mica-wb-resource-details"
        label={detailsTitle}
      >
        {!program && reference?.mode === 'asset' && (
          <div className="mica-wb-resource-details">UUID：{reference.assetId}</div>
        )}
        {program && (
          <div className="mica-wb-resource-details">
            {reference?.mode === 'asset' && <div>UUID：{reference.assetId}</div>}
            {memory && (
              <>
                <div>格式：{format?.toUpperCase() ?? '等待产物信息'}</div>
                {format === 'elf' &&
                  Object.entries(spaces).map(([id, space]) => (
                    <div key={id}>
                      {space.title ?? id}: [0x{space.start.toString(16)}, 0x
                      {(space.start + space.size).toString(16)})
                    </div>
                  ))}
                {(format === 'bin' || format === 'hex') && (
                  <label>
                    地址空间
                    <select
                      aria-label="地址空间"
                      value={selectedSpace ?? ''}
                      disabled={
                        props.disabled || busy || Object.keys(spaces).length < 2 || !reference
                      }
                      onChange={(event) => {
                        const addressSpace = event.target.value;
                        if (
                          format === 'bin' &&
                          loadAddress !== undefined &&
                          !validAddress(addressSpace, loadAddress)
                        ) {
                          fail(new Error('program/out-of-range'));
                          return;
                        }
                        if (reference) void perform(async () => ({ ...reference, addressSpace }));
                      }}
                    >
                      {Object.entries(spaces).map(([id, space]) => (
                        <option key={id} value={id}>
                          {space.title ?? id}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {format === 'bin' && (
                  <label>
                    装载地址
                    <input
                      aria-label="装载地址"
                      value={address}
                      disabled={props.disabled || busy || !reference}
                      onChange={(event) => setAddress(event.target.value)}
                      onBlur={saveAddress}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          saveAddress();
                        }
                      }}
                    />
                  </label>
                )}
                {snapshot &&
                  typeof snapshot === 'object' &&
                  'kind' in snapshot &&
                  snapshot.kind === 'firmware' &&
                  snapshot.segments.map((segment, index) => (
                    <div key={index}>
                      {segment.addressSpace}: 0x{segment.address.toString(16)} ·{' '}
                      {segment.bytes.byteLength} 字节
                    </div>
                  ))}
              </>
            )}
          </div>
        )}
      </ResourcePopover>
    </div>
  );
}
