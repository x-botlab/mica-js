import type { Disposable, Event } from '@mica-js/core/lifecycle';
import type { TimePs } from '@mica-js/core';
import type {
  DeviceLock,
  Endpoint,
  FusedDocument,
  InstanceViewLayout,
  Placement2D,
  Point2D,
  PropertyValue,
} from '@mica-js/document/fused';
import type {
  IDeviceProvider,
  IFileSystemProvider,
  IFirmwareProjectProvider,
  IWorkbenchAccessProvider,
} from './providers';
import type { IContextKeyService } from './context';
import type { IWorkbenchTheme, WorkbenchTheme } from './theme';

export type WorkbenchMode = 'edit' | 'run';
export type WorkbenchTool = 'select' | 'wire' | 'power' | 'ground' | 'label';
export type WorkbenchTargetKind = 'instance' | 'wire' | 'node' | 'label' | 'reference';

export interface IWorkbenchTarget {
  readonly kind: WorkbenchTargetKind;
  readonly id: string;
}

export interface IWorkbenchState {
  readonly mode: WorkbenchMode;
  readonly busy: boolean;
  readonly dirty: boolean;
  readonly readOnly: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly tool: WorkbenchTool;
  readonly activeContainer: string | undefined;
}

export interface IWorkbenchDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly instanceId?: string;
}

export interface IWorkbenchCommand<P = void, R = void> {
  readonly params: P;
  readonly result: R;
}

export interface IWorkbenchCommandMap {
  'workbench.openContainer': IWorkbenchCommand<{ readonly id: string; readonly focus?: boolean }>;
  'workbench.closeContainer': IWorkbenchCommand;
  'workbench.setMode': IWorkbenchCommand<{ readonly mode: WorkbenchMode }>;
  'canvas.fit': IWorkbenchCommand;
  'canvas.zoom': IWorkbenchCommand<{ readonly factor: number }>;
  'canvas.setTool': IWorkbenchCommand<{ readonly tool: WorkbenchTool }>;
  'device.place': IWorkbenchCommand<{ readonly device: DeviceLock }>;
  'device.add': IWorkbenchCommand<
    { readonly device: DeviceLock; readonly placement: Placement2D },
    string
  >;
  'device.setProperty': IWorkbenchCommand<{
    readonly instanceId: string;
    readonly key: string;
    readonly value: PropertyValue;
  }>;
  'device.removeProperty': IWorkbenchCommand<{ readonly instanceId: string; readonly key: string }>;
  'device.move': IWorkbenchCommand<{ readonly instanceId: string; readonly position: Point2D }>;
  'device.rotate': IWorkbenchCommand<{ readonly instanceId: string; readonly degrees: number }>;
  'selection.delete': IWorkbenchCommand;
  'wire.add': IWorkbenchCommand<
    { readonly from: Endpoint; readonly to: Endpoint; readonly bends?: readonly Point2D[] },
    string
  >;
  'reference.add': IWorkbenchCommand<
    { readonly target: Endpoint; readonly voltage: number; readonly symbol?: 'power' | 'ground' },
    string
  >;
  'label.add': IWorkbenchCommand<{ readonly target: Endpoint; readonly name: string }, string>;
  'document.undo': IWorkbenchCommand;
  'document.redo': IWorkbenchCommand;
  'document.save': IWorkbenchCommand;
  'firmware.createProject': IWorkbenchCommand<{
    readonly instanceId: string;
    readonly propertyKey: string;
  }>;
  'view.open': IWorkbenchCommand<{
    readonly instanceId: string;
    readonly viewId: string;
    readonly location?: 'sidebar' | 'floating';
  }>;
  'view.close': IWorkbenchCommand<{ readonly instanceId: string; readonly viewId: string }>;
  'view.setLocation': IWorkbenchCommand<{
    readonly instanceId: string;
    readonly viewId: string;
    readonly location: 'sidebar' | 'floating';
  }>;
  'view.setLayout': IWorkbenchCommand<{
    readonly instanceId: string;
    readonly layout: InstanceViewLayout | undefined;
  }>;
}

export type WorkbenchCommandArgs<C extends { readonly params: unknown }> = [C['params']] extends [
  void,
]
  ? []
  : [params: C['params']];

export interface IWorkbenchExtensionContext {
  readonly workbench: IWorkbench;
  readonly contextKeys: IContextKeyService;
  readonly signal: AbortSignal;
}

export interface IWorkbenchViewContainer {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly order?: number;
  readonly when?: string;
}

export interface IWorkbenchView {
  readonly id: string;
  readonly containerId: string;
  readonly title: string;
  readonly order?: number;
  readonly when?: string;
  mount(
    element: HTMLElement,
    context: IWorkbenchExtensionContext,
  ): Disposable | Promise<Disposable>;
}

export interface IWorkbenchToolbarItem {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly group?: string;
  readonly order?: number;
  readonly when?: string;
  readonly enablement?: string;
  execute(context: IWorkbenchExtensionContext): void | Promise<void>;
}

export interface IWorkbenchContributions {
  readonly containers?: readonly IWorkbenchViewContainer[];
  readonly views?: readonly IWorkbenchView[];
  readonly toolbar?: readonly IWorkbenchToolbarItem[];
}

export interface IWorkbenchOptions {
  readonly container: HTMLElement;
  readonly uri: string;
  readonly fileSystemProvider: IFileSystemProvider;
  readonly deviceProvider: IDeviceProvider;
  readonly firmwareProjectProvider?: IFirmwareProjectProvider;
  readonly accessProvider?: IWorkbenchAccessProvider;
  readonly viewBaseUrlTemplate: string;
  readonly theme?: WorkbenchTheme;
  readonly readOnly?: boolean;
  readonly step?: TimePs;
  readonly contributions?: IWorkbenchContributions;
}

export interface IWorkbench {
  readonly uri: string;
  readonly contextKeys: IContextKeyService;
  readonly onDidChangeContent: Event<FusedDocument>;
  readonly onDidChangeSelection: Event<readonly IWorkbenchTarget[]>;
  readonly onDidChangeState: Event<IWorkbenchState>;
  readonly onDidReportDiagnostic: Event<IWorkbenchDiagnostic>;
  readonly onDidRequestOpenProject: Event<{ readonly projectId: string }>;
  getDocument(): FusedDocument;
  getState(): IWorkbenchState;
  getSelection(): readonly IWorkbenchTarget[];
  getTheme(): IWorkbenchTheme;
  setTheme(theme: WorkbenchTheme): void;
  setSelection(targets: readonly IWorkbenchTarget[]): void;
  setMode(mode: WorkbenchMode): Promise<void>;
  save(): Promise<void>;
  executeCommand<K extends keyof IWorkbenchCommandMap>(
    id: K,
    ...args: WorkbenchCommandArgs<IWorkbenchCommandMap[K]>
  ): Promise<IWorkbenchCommandMap[K]['result']>;
  dispose(): Promise<void>;
}
