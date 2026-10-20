import {
  GROUND_DEVICE,
  POWER_DEVICE,
  isTextDevice,
  type PropertyValue,
} from '@mica/core/schematic';
import type { Inspector, PropertyField } from '../controller/types';

export interface PropertyPanelOptions {
  readonly readOnly: boolean;
  readonly onPropertyChange: (symbolId: string, key: string, value: PropertyValue) => void;
  readonly onPropertyReset: (symbolId: string, key: string) => void;
  readonly onRename: (symbolId: string, nextId: string) => void;
}

const EMPTY_HINT = '未选择图元';
const EMPTY_TIP = '选择器件或导线后在此查看与编辑';

/** Right-hand inspector column. Reads `controller.inspect()` and writes through callbacks. */
export class PropertyPanel {
  readonly element: HTMLElement;
  readonly #options: PropertyPanelOptions;

  constructor(options: PropertyPanelOptions) {
    this.#options = options;
    this.element = document.createElement('aside');
    this.element.className = 'mica-schematic__panel';
    this.update(undefined);
  }

  update(inspector: Inspector): void {
    const element = this.element;
    element.replaceChildren();
    if (inspector === undefined) {
      element.append(section('属性'));
      element.append(hint(EMPTY_HINT));
      element.append(tip(EMPTY_TIP));
      return;
    }
    if (inspector.kind === 'wire') {
      element.append(section(`导线 ${inspector.id}`));
      element.append(
        row('网络', inspector.netName ?? '未命名'),
        row('端点数', String(inspector.points.length)),
        row('起点', formatPoint(inspector.points[0])),
        row('终点', formatPoint(inspector.points[inspector.points.length - 1])),
      );
      return;
    }

    element.append(section(`器件 ${inspector.id}`));
    element.append(
      this.#referenceField(inspector.id, inspector.device),
      row('器件', inspector.device),
      row('名称', inspector.name ?? '—'),
      row('位置', `${formatNumber(inspector.x)}, ${formatNumber(inspector.y)}`),
      row('旋转', `${formatNumber(inspector.rotation)}°`),
    );
    if (inspector.properties.length === 0) {
      element.append(tip('该器件未声明可编辑属性'));
      return;
    }
    element.append(section('属性'));
    for (const field of inspector.properties) {
      element.append(this.#field(inspector.id, field));
    }
  }

  #referenceField(symbolId: string, device: string): HTMLElement {
    const wrapper = document.createElement('label');
    wrapper.className = 'mica-schematic__field';
    const label = document.createElement('span');
    label.className = 'mica-schematic__field-label';
    label.textContent = '位号';
    // The id is the reference designator; for net labels it doubles as the net name.
    const editable = device !== POWER_DEVICE && device !== GROUND_DEVICE && !isTextDevice(device);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = symbolId;
    input.disabled = this.#options.readOnly || !editable;
    input.className = 'mica-schematic__field-input';
    input.addEventListener('change', () => {
      const next = input.value.trim();
      if (next === '' || next === symbolId) {
        input.value = symbolId;
        return;
      }
      this.#options.onRename(symbolId, next);
    });
    wrapper.append(label, input);
    return wrapper;
  }

  #field(symbolId: string, field: PropertyField): HTMLElement {
    const wrapper = document.createElement('label');
    wrapper.className = 'mica-schematic__field';

    const label = document.createElement('span');
    label.className = 'mica-schematic__field-label';
    label.textContent = field.key;
    wrapper.append(label);

    const value = field.value ?? field.defaultValue;
    const placeHolder = field.defaultValue === undefined ? '' : String(field.defaultValue);

    if (field.type === 'boolean') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = value === true;
      input.disabled = this.#options.readOnly;
      input.addEventListener('change', () => {
        this.#options.onPropertyChange(symbolId, field.key, input.checked);
      });
      wrapper.append(input);
      return wrapper;
    }

    const input = document.createElement('input');
    input.type = field.type === 'number' ? 'number' : 'text';
    input.value = value === undefined ? '' : String(value);
    input.placeholder = placeHolder;
    input.disabled = this.#options.readOnly;
    input.className = 'mica-schematic__field-input';
    input.addEventListener('change', () => {
      const text = input.value.trim();
      if (text === '') {
        this.#options.onPropertyReset(symbolId, field.key);
        return;
      }
      if (field.type === 'number') {
        const parsed = Number(text);
        if (!Number.isFinite(parsed)) {
          input.value = value === undefined ? '' : String(value);
          return;
        }
        this.#options.onPropertyChange(symbolId, field.key, parsed);
        return;
      }
      this.#options.onPropertyChange(symbolId, field.key, text);
    });
    wrapper.append(input);
    return wrapper;
  }
}

function section(title: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'mica-schematic__section';
  element.textContent = title;
  return element;
}

function row(key: string, value: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'mica-schematic__row';
  const keyElement = document.createElement('span');
  keyElement.className = 'mica-schematic__row-key';
  keyElement.textContent = key;
  const valueElement = document.createElement('span');
  valueElement.className = 'mica-schematic__row-value';
  valueElement.textContent = value;
  valueElement.title = value;
  element.append(keyElement, valueElement);
  return element;
}

function hint(text: string): HTMLElement {
  const element = document.createElement('p');
  element.className = 'mica-schematic__hint';
  element.textContent = text;
  return element;
}

function tip(text: string): HTMLElement {
  const element = document.createElement('p');
  element.className = 'mica-schematic__tip';
  element.textContent = text;
  return element;
}

function formatPoint(point: { readonly x: number; readonly y: number } | undefined): string {
  return point === undefined ? '—' : `${formatNumber(point.x)}, ${formatNumber(point.y)}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
