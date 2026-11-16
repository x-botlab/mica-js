import type { Event } from '@mica-js/core/lifecycle';
import type { DeviceLock, FusedDocument } from '@mica-js/document/fused';
import type { FirmwareArtifact, FirmwareProject, FirmwareProjectSource } from '@mica-js/sdk/fused';
import type { HostFs } from '@mica-js/widget';

export interface IFileSystemProvider extends HostFs {
  write(uri: string, data: Uint8Array): Promise<void>;
}

export type { DeviceRegistry as IDeviceProvider } from '@mica-js/document/fused';

export interface IFirmwareProjectCreationContext {
  readonly documentUri: string;
  readonly instanceId: string;
  readonly device: DeviceLock;
  readonly propertyKey: string;
  readonly signal: AbortSignal;
}

export interface IFirmwareProjectProvider extends FirmwareProjectSource {
  create?(context: IFirmwareProjectCreationContext): Promise<FirmwareProject | undefined>;
}

export type AccessDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string; readonly message: string };

export interface IDocumentAccess {
  readonly edit: AccessDecision;
  readonly run: AccessDecision;
}

export interface IDocumentAccessContext {
  readonly uri: string;
  readonly document: FusedDocument;
}

export interface IDeviceAdditionContext extends IDocumentAccessContext {
  readonly device: DeviceLock;
}

export interface IWorkbenchAccessProvider {
  evaluateDocument(context: IDocumentAccessContext): Promise<IDocumentAccess>;
  canAddDevice(context: IDeviceAdditionContext): Promise<AccessDecision>;
  readonly onDidChange: Event<void>;
}

export type { FirmwareArtifact, FirmwareProject };
