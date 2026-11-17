/**
 * Fused `.sch` version 2 document: device instances, explicit connection graph, net labels,
 * ideal voltage references and instance view layouts (RFC 0024).
 */
import type { Point2D } from './geometry';
import type { PropertyValue } from './property';

/** Version of the fused schematic document contract (RFC 0024). */
export const FUSED_DOCUMENT_VERSION = 2;

export type FusedDocumentVersion = typeof FUSED_DOCUMENT_VERSION;

/** Exact release a document depends on (RFC 0020 / RFC 0024). */
export interface DeviceDependency {
  readonly version: string;
  /** `sha256:` plus 64 lowercase hexadecimal digits of the release identity. */
  readonly integrity: string;
}

/** Placement of an instance in scene millimetres (RFC 0024). */
export interface Placement2D extends Point2D {
  /** Clockwise rotation in degrees around the device's local origin. */
  readonly rotation: number;
  /** Flexible devices carry a finite positive layout width. */
  readonly width?: number;
  /** Flexible devices carry a finite positive layout height. */
  readonly height?: number;
}

/** Collapsible sidebar panel layout of the built-in property view (RFC 0024). */
export interface SidebarViewLayout {
  /** Content height in CSS px while expanded. */
  readonly height: number;
  readonly collapsed: boolean;
}

/** Last floating rectangle of an HTML view, relative to the editor's available area (RFC 0024). */
export interface FloatingBounds extends Point2D {
  readonly width: number;
  readonly height: number;
}

/** Layout of one HTML view of the owning device type (RFC 0024). */
export interface HtmlViewLayout extends SidebarViewLayout {
  readonly viewId: string;
  readonly location: 'sidebar' | 'floating';
  readonly floatingBounds?: FloatingBounds;
}

/** Per-instance sidebar and HTML view layout (RFC 0024). */
export interface InstanceViewLayout {
  readonly properties: SidebarViewLayout;
  readonly views: readonly HtmlViewLayout[];
}

/** One placed device or display-only object (RFC 0024). */
export interface FusedInstance {
  /** Document-unique UUID v4. */
  readonly id: string;
  /** Full `publisher:name` device id, locked by the dependency table. */
  readonly device: string;
  readonly designator?: string;
  /** Offset from the package's designator anchor, in device-local millimetres. */
  readonly designatorOffset?: Point2D;
  readonly placement: Placement2D;
  readonly properties?: Readonly<Record<string, PropertyValue>>;
  /** Per-instance body image override; falls back to the document setting. */
  readonly display?: { readonly body?: boolean };
  readonly viewLayout?: InstanceViewLayout;
}

/** Connection target of a wire, label or voltage reference (RFC 0024). */
export type Endpoint =
  | { readonly kind: 'pin'; readonly instance: string; readonly pin: string }
  | { readonly kind: 'node'; readonly node: string };

/** Explicit connection node: a drawn branch point or a free wire end (RFC 0024). */
export interface ConnectionNode extends Point2D {
  readonly id: string;
  readonly kind: 'junction' | 'free';
}

/** Connection edge between two endpoints with its intermediate bends (RFC 0024). */
export interface ConnectionWire {
  readonly id: string;
  readonly from: Endpoint;
  readonly to: Endpoint;
  /** Intermediate points only; the full polyline is derived from the endpoints. */
  readonly bends: readonly Point2D[];
}

/** Net name declared on one endpoint (RFC 0024). */
export interface NetLabel {
  readonly id: string;
  readonly target: Endpoint;
  readonly name: string;
  readonly offset?: Point2D;
}

/** Ideal voltage reference attached to one endpoint (RFC 0024). */
export interface VoltageReference {
  readonly id: string;
  readonly target: Endpoint;
  /** `0` is the global ground reference. */
  readonly voltage: number;
  /** Built-in power or ground symbol; omitted when only the voltage constraint is stored. */
  readonly symbol?: 'power' | 'ground';
  /** Clockwise rotation in degrees; defaults to `0`. */
  readonly rotation?: number;
  /** Net name owned by the symbol together with its display offset. */
  readonly label?: { readonly name: string; readonly offset?: Point2D };
}

/** Run-time body and designator display settings of the document (RFC 0024). */
export interface FusedDisplaySettings {
  readonly body?: boolean;
  readonly designators?: boolean;
}

/** Root contract of a fused `.sch` version 2 file (RFC 0024). */
export interface FusedDocument {
  readonly version: FusedDocumentVersion;
  /** Device id to locked release; every instance device must be locked here. */
  readonly dependencies: Readonly<Record<string, DeviceDependency>>;
  readonly instances: readonly FusedInstance[];
  readonly nodes: readonly ConnectionNode[];
  readonly wires: readonly ConnectionWire[];
  readonly labels: readonly NetLabel[];
  readonly references: readonly VoltageReference[];
  readonly display?: FusedDisplaySettings;
}
