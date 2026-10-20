import { SchematicError } from './errors';
import type { Diagnostic } from './diagnostics';

function catchError(run: () => unknown): SchematicError {
  try {
    run();
  } catch (error) {
    if (error instanceof SchematicError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a SchematicError to be thrown');
}

function codesOf(diagnostics: readonly Diagnostic[]): readonly string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

export { catchError, codesOf };
