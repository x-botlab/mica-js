import { useLayoutEffect, useRef, useState } from 'react';
import type { IWorkbenchExtensionContext, IWorkbenchState, IWorkbenchToolbarItem } from '../types';
import type { ContributionRegistry } from '../contributions/registry';
import { Icon } from './activity-bar-part';

export function ToolbarPart(props: {
  readonly state: IWorkbenchState;
  readonly registry: ContributionRegistry;
  readonly context: IWorkbenchExtensionContext;
  readonly onError: (error: unknown) => void;
}) {
  const [more, setMore] = useState(false);
  const toolbar = useRef<HTMLDivElement>(null);
  const modeGroup = useRef<HTMLDivElement>(null);
  const measurements = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLSpanElement>(null);
  const [layout, setLayout] = useState({ compact: false, count: Infinity });
  const items = props.registry.toolbar.filter((item) => props.registry.visible(item));
  useLayoutEffect(() => {
    const element = toolbar.current;
    const mode = modeGroup.current;
    const measure = measurements.current;
    const parent = element?.parentElement;
    if (!element || !mode || !measure || !parent) return;
    const update = () => {
      const style = getComputedStyle(element);
      const number = (value: string) => Number.parseFloat(value) || 0;
      const available = parent.clientWidth - number(style.left) * 2;
      const base =
        mode.getBoundingClientRect().width +
        number(style.paddingLeft) +
        number(style.paddingRight) +
        number(style.borderLeftWidth) +
        number(style.borderRightWidth);
      const separator = divider.current;
      const separatorStyle = separator && getComputedStyle(separator);
      const separatorWidth =
        separator && separatorStyle
          ? separator.getBoundingClientRect().width +
            number(separatorStyle.marginLeft) +
            number(separatorStyle.marginRight)
          : 0;
      const rows = [...measure.children];
      const widths = (row: Element | undefined) =>
        row ? [...row.children].map((child) => child.getBoundingClientRect().width) : [];
      const full = widths(rows[0]);
      const compact = widths(rows[1]);
      const gap = number(style.columnGap);
      const itemGap = rows[0] ? number(getComputedStyle(rows[0]).columnGap) : 0;
      const moreWidth = rows[2]?.getBoundingClientRect().width ?? 0;
      const required = (values: number[], count: number, overflow: boolean) =>
        base +
        separatorWidth +
        values.slice(0, count).reduce((sum, width) => sum + width, 0) +
        Math.max(0, count - 1) * itemGap +
        (overflow ? moreWidth : 0) +
        ((count > 0 ? 1 : 0) + (overflow ? 1 : 0) + (items.length > 0 ? 1 : 0)) * gap;
      let next = { compact: false, count: items.length };
      if (required(full, full.length, false) > available) {
        next = { compact: true, count: items.length };
        if (required(compact, compact.length, false) > available) {
          while (next.count > 0 && required(compact, next.count, true) > available) next.count--;
        }
      }
      setLayout((current) =>
        current.compact === next.compact && current.count === next.count ? current : next,
      );
      if (next.count === items.length) setMore(false);
    };
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    observer.observe(mode);
    for (const row of measure.children) observer.observe(row);
    update();
    return () => observer.disconnect();
  }, [items]);
  const visible = items.slice(0, layout.count);
  const overflow = items.slice(layout.count);
  const execute = (item: IWorkbenchToolbarItem) => {
    setMore(false);
    if (!props.registry.enabled(item)) return;
    try {
      void Promise.resolve(item.execute(props.context)).catch(props.onError);
    } catch (error) {
      props.onError(error);
    }
  };
  const itemButton = (item: IWorkbenchToolbarItem) => (
    <button
      key={item.id}
      className={item.icon === undefined ? undefined : 'mica-wb-icon-tool'}
      title={item.title}
      aria-label={item.title}
      disabled={!props.registry.enabled(item)}
      aria-pressed={
        item.id.startsWith('mica.tool.')
          ? props.state.tool === item.id.slice('mica.tool.'.length)
          : undefined
      }
      onClick={() => execute(item)}
    >
      {item.icon !== undefined && <Icon name={item.icon} />}
      <span className="mica-wb-toolbar-label">{item.title}</span>
    </button>
  );
  return (
    <div ref={toolbar} className="mica-wb-toolbar" role="toolbar" aria-label="电路工具">
      <div ref={measurements} className="mica-wb-toolbar-measure" aria-hidden="true" inert>
        <div className="mica-wb-tools-inline">{items.map(itemButton)}</div>
        <div className="mica-wb-tools-inline" data-compact="true">
          {items.map(itemButton)}
        </div>
        <span className="mica-wb-more-button">
          <Icon name="ellipsis" />
        </span>
      </div>
      <div
        ref={modeGroup}
        className="mica-wb-mode"
        role="group"
        aria-label="工作台模式"
        data-mode={props.state.mode}
      >
        {(['edit', 'run'] as const).map((mode) => (
          <button
            key={mode}
            aria-pressed={props.state.mode === mode}
            disabled={props.state.busy}
            className={props.state.mode === mode ? 'is-active' : ''}
            onClick={() => {
              setMore(false);
              void props.context.workbench.setMode(mode).catch(props.onError);
            }}
          >
            <Icon name={mode === 'edit' ? 'edit' : 'play'} />
            {mode === 'edit' ? '编辑' : '运行'}
          </button>
        ))}
      </div>
      {items.length > 0 && (
        <>
          <span ref={divider} className="mica-wb-toolbar-divider" />
          {visible.length > 0 && (
            <div className="mica-wb-tools-inline" data-compact={layout.compact}>
              {visible.map(itemButton)}
            </div>
          )}
          {overflow.length > 0 && (
            <span className="mica-wb-more">
              <button
                className="mica-wb-more-button"
                aria-label="更多工具"
                title="更多工具"
                aria-expanded={more}
                onClick={() => setMore(!more)}
              >
                <Icon name="ellipsis" />
              </button>
              {more && (
                <div className="mica-wb-more-menu" aria-label="其他工具">
                  {overflow.map(itemButton)}
                </div>
              )}
            </span>
          )}
        </>
      )}
    </div>
  );
}
