/** Diagnostics of the headless fused runtime (RFC 0025). */
import { FusedDocumentError } from '@mica-js/document/fused';

/**
 * One host-visible runtime diagnostic.
 *
 * `code` is a stable contract code (RFC 0020 / 0021 / 0024 / 0025 / 0026). `message` is meant for
 * humans and carries the instance id, property name or package path that caused the problem.
 */
export interface RuntimeDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly instanceId?: string;
}

export type DiagnosticSink = (diagnostic: RuntimeDiagnostic) => void;

export function diagnostic(code: string, message: string, instanceId?: string): RuntimeDiagnostic {
  return instanceId === undefined ? { code, message } : { code, message, instanceId };
}

/** One preparation problem before it is attributed to an instance. */
export interface PreparationProblem {
  readonly code: string;
  readonly message: string;
  /** JSON Pointer of the offending member; empty when the problem has no document location. */
  readonly pointer: string;
}

/** Thrown while preparing a session; carries every problem found before failing. */
export class PreparationError extends Error {
  readonly problems: readonly PreparationProblem[];

  constructor(problems: readonly PreparationProblem[]) {
    const first = problems[0];
    super(
      first === undefined
        ? 'Fused session preparation failed.'
        : `${first.code}${first.pointer === '' ? '' : ` at ${first.pointer}`}: ${first.message}`,
    );
    this.name = 'PreparationError';
    this.problems = problems;
  }

  get code(): string {
    return this.problems[0]?.code ?? 'runtime/prepare-failed';
  }
}

/** Thrown by {@link createHeadlessRuntime} when preparation fails; carries all diagnostics. */
export class FusedPreparationError extends Error {
  readonly code: string;
  readonly diagnostics: readonly RuntimeDiagnostic[];

  constructor(diagnostics: readonly RuntimeDiagnostic[]) {
    const first = diagnostics[0];
    super(first === undefined ? 'Fused session preparation failed.' : first.message);
    this.name = 'FusedPreparationError';
    this.code = first?.code ?? 'runtime/prepare-failed';
    this.diagnostics = diagnostics;
  }
}

export function problem(code: string, message: string, pointer = ''): PreparationProblem {
  return { code, message, pointer };
}

/**
 * Normalizes a thrown value into preparation problems.
 *
 * Contract violations of `@mica-js/document/fused` already carry a code and a JSON Pointer per
 * problem, so they are forwarded one to one instead of being flattened into one message.
 */
export function asPreparation(cause: unknown, fallbackCode: string): readonly PreparationProblem[] {
  if (cause instanceof PreparationError) {
    return cause.problems;
  }
  if (isPreparationProblem(cause)) {
    return [cause];
  }
  if (cause instanceof FusedDocumentError) {
    const problems = cause.diagnostics
      .filter((entry) => entry.severity === 'error')
      .map((entry) => problem(entry.code, entry.message, entry.pointer));
    if (problems.length > 0) {
      return problems;
    }
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return [problem(fallbackCode, message)];
}

function isPreparationProblem(value: unknown): value is PreparationProblem {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as { code?: unknown; message?: unknown; pointer?: unknown };
  return (
    typeof entry.code === 'string' &&
    typeof entry.message === 'string' &&
    typeof entry.pointer === 'string'
  );
}

/** Collects the problems of one preparation phase and attributes them to an instance. */
export class DiagnosticBatch {
  readonly problems: PreparationProblem[] = [];
  readonly instanceIds: (string | undefined)[] = [];

  add(cause: unknown, fallbackCode: string, instanceId?: string): void {
    for (const entry of asPreparation(cause, fallbackCode)) {
      this.problems.push(entry);
      this.instanceIds.push(instanceId);
    }
  }

  addProblem(entry: PreparationProblem, instanceId?: string): void {
    this.problems.push(entry);
    this.instanceIds.push(instanceId);
  }

  fail(cause: unknown, fallbackCode: string, instanceId?: string): void {
    this.add(cause, fallbackCode, instanceId);
    throw new PreparationError(this.problems);
  }

  get empty(): boolean {
    return this.problems.length === 0;
  }

  /** Every collected problem as a host diagnostic, then clears the batch. */
  drain(): RuntimeDiagnostic[] {
    const diagnostics = this.problems.map((entry, index) =>
      diagnostic(
        entry.code,
        entry.pointer === '' ? entry.message : `${entry.message} (${entry.pointer})`,
        this.instanceIds[index],
      ),
    );
    this.problems.length = 0;
    this.instanceIds.length = 0;
    return diagnostics;
  }
}
