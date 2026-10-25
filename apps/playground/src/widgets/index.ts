import type { PackageFiles } from '@mica-js/widget';
import animationDefinition from './animation/animation.json?raw';
import animationCode from './animation/animation.js?raw';
import imageViewerDefinition from './image-viewer/image-viewer.json?raw';
import imageViewerCode from './image-viewer/image-viewer.js?raw';
import ledDefinition from './led/led.json?raw';
import ledCode from './led/led.js?raw';
import manifest from './manifest.json?raw';
import potentiometerDefinition from './potentiometer/potentiometer.json?raw';
import potentiometerCode from './potentiometer/potentiometer.js?raw';
import powerSwitchDefinition from './power-switch/power-switch.json?raw';
import powerSwitchCode from './power-switch/power-switch.js?raw';
import textDisplayDefinition from './text-display/text-display.json?raw';
import textDisplayCode from './text-display/text-display.js?raw';
import voltmeterDefinition from './voltmeter/voltmeter.json?raw';
import voltmeterCode from './voltmeter/voltmeter.js?raw';

/**
 * The playground's own widget package.
 *
 * Every widget lives in this folder as a `*.json` definition plus a `*.js`
 * implementation, exactly like a published package — the only difference is that
 * the files are bundled by Vite (`?raw`) instead of being fetched from `public/`,
 * so the sandbox receives the same source a package build would ship.
 *
 * The runtime only ever sees a {@link PackageFiles} view: a manifest at
 * `package.json` and one definition plus one implementation per widget.
 */

const FILES: Readonly<Record<string, string>> = Object.freeze({
  'package.json': manifest,
  'animation/animation.json': animationDefinition,
  'animation/animation.js': animationCode,
  'image-viewer/image-viewer.json': imageViewerDefinition,
  'image-viewer/image-viewer.js': imageViewerCode,
  'led/led.json': ledDefinition,
  'led/led.js': ledCode,
  'potentiometer/potentiometer.json': potentiometerDefinition,
  'potentiometer/potentiometer.js': potentiometerCode,
  'power-switch/power-switch.json': powerSwitchDefinition,
  'power-switch/power-switch.js': powerSwitchCode,
  'text-display/text-display.json': textDisplayDefinition,
  'text-display/text-display.js': textDisplayCode,
  'voltmeter/voltmeter.json': voltmeterDefinition,
  'voltmeter/voltmeter.js': voltmeterCode,
});

const encoder = new TextEncoder();

/** Package files backed by the bundled sources above. */
export const PLAYGROUND_WIDGET_FILES: PackageFiles = Object.freeze({
  label: 'lab',
  read(path: string): Promise<Uint8Array> {
    const text = FILES[path];
    if (text === undefined) {
      return Promise.reject(new Error(`Widget package "lab" has no file ${JSON.stringify(path)}.`));
    }
    return Promise.resolve(encoder.encode(text));
  },
});

/** Widget references this package provides, in manifest order. */
export const PLAYGROUND_WIDGETS = Object.freeze([
  'lab:animation',
  'lab:image-viewer',
  'lab:led',
  'lab:potentiometer',
  'lab:power-switch',
  'lab:text-display',
  'lab:voltmeter',
]);

/** File map, exposed for the widget tests. */
export function playgroundWidgetSource(path: string): string | undefined {
  return FILES[path];
}
