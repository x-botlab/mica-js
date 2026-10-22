import type { EntryRef, LifecycleRef, ScalarType } from '@mica-js/ir';
import {
  addTime,
  createIRSchedulerInstance,
  createScheduler,
  timePs,
  type IRSchedulerInstance,
  type Scheduler,
  type SchedulerExecutionContext,
  type SchedulerInstance,
  type SchedulerTarget,
  type TimePs,
} from './index';

declare const ordinary: EntryRef;
declare const lifecycle: LifecycleRef;
declare const irInstance: IRSchedulerInstance;
declare const context: SchedulerExecutionContext;
declare const instance: SchedulerInstance;

const now: TimePs = addTime(timePs(0), 1);
const ordinaryNumber: number = now;
void ordinaryNumber;
// @ts-expect-error Plain numbers must pass a time boundary to become branded.
const unchecked: TimePs = 0;
void unchecked;
const target: SchedulerTarget = {
  name: 'event',
  kind: 'event',
  params: ['bool', 'f64'] satisfies readonly ScalarType[],
};
const scheduler: Scheduler = createScheduler({ maxEntriesPerTime: 100 });
instance.at(target, 0, [true, 1]);
scheduler.enqueueControl(instance, { name: 'P', kind: 'control', params: [] }, []);
const id: number = irInstance.at(ordinary, 0, []);
irInstance.cancel(id);
irInstance.enqueueControl(lifecycle, []);
const messageId: number = scheduler.enqueueMessage(instance, target, [true, 1]);
const irMessageId: number = irInstance.enqueueMessage(ordinary, []);
const contextMessageId: number = context.messageId;
void [messageId, irMessageId, contextMessageId];
// @ts-expect-error Lifecycle references cannot enter the ordinary message queue.
irInstance.enqueueMessage(lifecycle, []);
// @ts-expect-error Lifecycle references are not ordinary event references.
irInstance.at(lifecycle, 0, []);
// @ts-expect-error Ordinary entries cannot enter the privileged control phase.
irInstance.enqueueControl(ordinary, []);
// @ts-expect-error Runtime scalars do not admit arbitrary closure objects.
instance.at(target, 0, [{ payload: 1 }]);
// @ts-expect-error Context time is immutable.
context.timePs = timePs(1);
// @ts-expect-error Instance identity cannot be retargeted after registration.
instance.instanceId = 'other';
void createIRSchedulerInstance;
