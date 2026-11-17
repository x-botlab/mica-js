import type { IWorkbenchViewContainer } from '../types';

export function Icon({ name }: { readonly name: string }) {
  return <span aria-hidden="true" className={`codicon codicon-${name}`} />;
}

export function ActivityBarPart(props: {
  readonly containers: readonly IWorkbenchViewContainer[];
  readonly active: string | undefined;
  readonly problemCount: number;
  readonly onActivate: (id: string) => void;
}) {
  return (
    <nav className="mica-wb-activity-bar" aria-label="工作台视图">
      {props.containers.map((container) => (
        <button
          key={container.id}
          title={container.title}
          aria-label={container.title}
          aria-pressed={props.active === container.id}
          className={props.active === container.id ? 'is-active' : ''}
          onClick={() => props.onActivate(container.id)}
        >
          <Icon name={container.icon} />
          {container.id === 'mica.problems' && props.problemCount > 0 && (
            <span className="mica-wb-badge">{props.problemCount}</span>
          )}
        </button>
      ))}
    </nav>
  );
}
