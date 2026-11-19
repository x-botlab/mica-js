import type { Event } from '@mica-js/core/lifecycle';
import type { DeviceLock, FusedDocument } from '@mica-js/document/fused';

export interface IAssetInfo {
  readonly id: string;
  /** File name including its extension; used to identify program formats. */
  readonly name: string;
}

export interface IAssetRequest {
  readonly kind: 'image' | 'binary' | 'program';
  readonly formats?: readonly string[];
  readonly signal: AbortSignal;
}

export interface IAssetProvider {
  select(request: IAssetRequest): Promise<IAssetInfo | undefined>;
  read(assetId: string, signal: AbortSignal): Promise<Uint8Array>;
}

export type { DeviceRegistry as IDeviceProvider } from '@mica-js/document/fused';

export type AccessDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string; readonly message: string };

export interface IDocumentAccess {
  readonly edit: AccessDecision;
  readonly run: AccessDecision;
}

export interface IDocumentAccessContext {
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
