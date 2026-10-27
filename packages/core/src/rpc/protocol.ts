export type RpcMessage =
  | { kind: 'call' | 'listen'; id: number; service: string; member: string; args: unknown[] }
  | { kind: 'unlisten'; id: number }
  | { kind: 'result'; id: number; value: unknown }
  | { kind: 'error' | 'subscription-error'; id: number; name: string; message: string }
  | { kind: 'event'; id: number; args: unknown[] }
  | { kind: 'close' };

export function isRpcMessage(value: unknown): value is RpcMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.kind === 'close') return true;
  if (!Number.isSafeInteger(message.id) || (message.id as number) <= 0) return false;
  switch (message.kind) {
    case 'call':
    case 'listen':
      return (
        typeof message.service === 'string' &&
        message.service.length > 0 &&
        typeof message.member === 'string' &&
        message.member.length > 0 &&
        Array.isArray(message.args) &&
        (message.kind !== 'listen' || message.args.length === 0)
      );
    case 'unlisten':
      return true;
    case 'result':
      return Object.hasOwn(message, 'value');
    case 'error':
    case 'subscription-error':
      return typeof message.name === 'string' && typeof message.message === 'string';
    case 'event':
      return Array.isArray(message.args);
    default:
      return false;
  }
}
