import type { CameraSensorData, SensorData } from './types';

declare const reading: SensorData;

if (reading.type === 'camera') {
  const image: Uint8ClampedArray = reading.image;
  const width: number = reading.width;
  void image;
  void width;
} else if (reading.type === 'distance') {
  const distance: number | null = reading.distance;
  void distance;
} else if (reading.type === 'imu') {
  const orientation: [number, number, number, number] = reading.orientation;
  void orientation;
}

// @ts-expect-error every reading carries a bigint timestamp in picoseconds
const missingTimestamp: SensorData = { type: 'light', intensity: 1 };
void missingTimestamp;
// @ts-expect-error a camera reading requires pixel data
const cameraWithoutImage: CameraSensorData = {
  type: 'camera',
  width: 1,
  height: 1,
  timestamp: 0n,
};
void cameraWithoutImage;
// @ts-expect-error a distance reading is numeric or null, never a string
const stringDistance: SensorData = { type: 'distance', distance: '1 m', timestamp: 0n };
void stringDistance;
// @ts-expect-error timestamps are bigint
const floatTimestamp: SensorData = { type: 'light', intensity: 1, timestamp: 0 };
void floatTimestamp;
// @ts-expect-error readings are immutable
reading.timestamp = 0n;
