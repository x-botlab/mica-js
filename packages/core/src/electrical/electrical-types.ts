export interface ElectricalPinInput {
  readonly instanceId: string;
  readonly pinName: string;
  readonly powerReady: boolean;
  readonly mode: 'high-z' | 'push-pull' | 'open-drain' | 'analog';
  readonly outputEnabled: boolean;
  readonly pull: 'none' | 'up' | 'down';
  readonly digitalIntent?: boolean;
  readonly voltageIntent?: number;
  readonly model: {
    readonly kind: 'ideal-voltage';
    readonly minVoltage: number;
    readonly maxVoltage: number;
    readonly lowVoltage: number;
    readonly highVoltage: number;
  };
}

export interface ElectricalNetworkInput {
  readonly networkId: string;
  readonly pins: readonly ElectricalPinInput[];
}

export interface ElectricalContribution {
  readonly instanceId: string;
  readonly pinName: string;
  readonly kind: 'drive' | 'pull';
  readonly strength: 'strong' | 'weak';
  readonly voltage: number;
}

export type ElectricalNetworkResult =
  | {
      readonly state: 'driven';
      readonly voltage: number;
      readonly strength: 'strong' | 'weak';
      readonly contributions: readonly ElectricalContribution[];
    }
  | {
      readonly state: 'floating';
      readonly digitalFallback: false;
      readonly contributions: readonly ElectricalContribution[];
    };

export type FloatingInputSample =
  { readonly state: 'disabled' } | { readonly state: 'ready'; readonly voltage: number };

export interface FloatingInput {
  beginFloating(supplyVoltage?: number): void;
  sample(supplyVoltage: number, timePs: number, enabled?: boolean): FloatingInputSample;
}
