export class IRConstructionError extends Error {
  override readonly name = 'IRConstructionError';
}

export function fail(message: string): never {
  throw new IRConstructionError(message);
}
