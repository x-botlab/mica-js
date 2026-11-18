import { useState } from 'react';
import type { FusedDocument } from '@mica-js/document/fused';
import type { ICanvasDevice } from '../canvas/geometry';
import type { IWorkbenchTarget } from '../types';

export function InstancesView(props: {
  readonly document: FusedDocument;
  readonly devices: ReadonlyMap<string, ICanvasDevice>;
  readonly selection: readonly IWorkbenchTarget[];
  readonly onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const instances = props.document.instances.filter((instance) =>
    `${instance.designator ?? ''} ${props.devices.get(instance.device)?.manifest.displayName ?? instance.device}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <section className="mica-wb-instances" aria-label="已放置器件">
      <input
        type="search"
        aria-label="搜索已放置器件"
        placeholder="搜索位号或器件"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div role="list" className="mica-wb-object-list">
        {instances.map((instance) => (
          <button
            role="listitem"
            key={instance.id}
            className={
              props.selection.some((target) => target.id === instance.id) ? 'is-active' : ''
            }
            onClick={() => props.onSelect(instance.id)}
          >
            <strong>{instance.designator ?? '—'}</strong>
            <span>
              {props.devices.get(instance.device)?.manifest.displayName ?? instance.device}
            </span>
          </button>
        ))}
      </div>
      {instances.length === 0 && (
        <p className="mica-wb-empty">{query ? '没有匹配的器件' : '尚未放置器件'}</p>
      )}
    </section>
  );
}
