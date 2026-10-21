import { createIRInterpreter } from './index';
import type {
  EntryRef,
  EventOperations,
  FunctionBuilder,
  FunctionRef,
  GeneratedFunctionBuilder,
  IREventHost,
  IRExecutionContext,
  IRInterpreterOptions,
  IRModule,
  IRStepObserver,
  LifecycleRef,
  RuntimeScalar,
  Value,
} from './index';
function expectType<T>(value: T): void {
  void value;
}
declare const b: FunctionBuilder;
declare const generated: GeneratedFunctionBuilder;
declare const entry: EntryRef<readonly ['u32', 'f64']>;
declare const ordinary: FunctionRef<readonly [], readonly []>;
declare const lifecycle: LifecycleRef<readonly []>;
declare const time: Value<'f64'>;
declare const id: Value<'u32'>;
declare const f32: Value<'f32'>;
declare const module: IRModule;
declare const options: IRInterpreterOptions;
expectType<EventOperations>(b.event);
expectType<Value<'f64'>>(b.event.now());
expectType<Value<'u32'>>(b.event.at(entry, time, [id, time]));
expectType<void>(b.event.cancel(id));
generated.at(generated.block([]), (nested) => {
  nested.event.cancel(id);
  return nested.return([]);
});
const eventHost: IREventHost = {
  now: () => 0,
  at(target, deadline, args) {
    expectType<EntryRef>(target);
    expectType<number>(deadline);
    expectType<readonly RuntimeScalar[]>(args);
    return 1;
  },
  cancel: (id) => {
    expectType<number>(id);
  },
};
const stepObserver: IRStepObserver = {
  beforeStep(context) {
    expectType<IRExecutionContext>(context);
  },
};
createIRInterpreter(module, { ...options, eventHost, stepObserver });
// @ts-expect-error ordinary functions are not event targets
b.event.at(ordinary, time, []);
// @ts-expect-error lifecycle hooks are not event targets
b.event.at(lifecycle, time, []);
// @ts-expect-error deadlines must be f64
b.event.at(entry, f32, [id, time]);
// @ts-expect-error deadline is SSA, not a host number
b.event.at(entry, 0, [id, time]);
// @ts-expect-error args cannot alter target signature inference
b.event.at(entry, time, [time, id]);
// @ts-expect-error all arguments are required
b.event.at(entry, time, [id]);
// @ts-expect-error too many arguments
b.event.at(entry, time, [id, time, id]);
// @ts-expect-error cancellation requires u32
b.event.cancel(time);
// @ts-expect-error cancellation requires an SSA value
b.event.cancel(0);
// @ts-expect-error host now must be synchronous and numeric
const invalidHost: IREventHost = { ...eventHost, now: async () => 0 };
// @ts-expect-error host at must return a numeric ID
const invalidAt: IREventHost = { ...eventHost, at: () => '1' };
void [invalidHost, invalidAt];
