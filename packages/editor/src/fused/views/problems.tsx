import type { IWorkbenchDiagnostic } from '../types';

export function ProblemsView(props: {
  readonly diagnostics: readonly IWorkbenchDiagnostic[];
  readonly onReveal: (id: string) => void;
}) {
  return (
    <section className="mica-wb-problems" aria-label="问题">
      {props.diagnostics.length === 0 && <p className="mica-wb-empty">没有发现问题</p>}
      {props.diagnostics.map((diagnostic, index) => (
        <button
          key={`${diagnostic.code}:${index}`}
          className={`mica-wb-diagnostic is-${diagnostic.severity}`}
          onClick={() => {
            if (diagnostic.instanceId !== undefined) props.onReveal(diagnostic.instanceId);
          }}
        >
          <strong>{diagnostic.code}</strong>
          <span>{diagnostic.message}</span>
        </button>
      ))}
    </section>
  );
}
