import { addTime, timePs, type TimePs } from './index';

const now: TimePs = addTime(timePs(0), 1);
const ordinaryNumber: number = now;
void ordinaryNumber;
// @ts-expect-error Plain numbers must pass a time boundary to become branded.
const unchecked: TimePs = 0;
void unchecked;
