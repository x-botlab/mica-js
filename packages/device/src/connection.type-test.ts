import type { TopologyRuntime } from '@mica-js/core';
import type { FunctionBuilder, Value } from '@mica-js/ir';
import type {
  ConnectionOperations,
  ConnectionRef,
  DeviceAPI,
  DeviceConnectionDescriptor,
  DeviceDescription,
  DeviceInstanceOptions,
} from './index';

declare const api: DeviceAPI;
declare const builder: FunctionBuilder;
declare const closed: Value<'bool'>;
declare const topology: TopologyRuntime;
declare const description: DeviceDescription;

const contact: ConnectionRef = api.ir.connection('contact');
const operations: ConnectionOperations = builder.connection;
const options: DeviceInstanceOptions = {
  instanceId: 'typed',
  connections: { topology },
};
const connections: ReadonlyMap<string, DeviceConnectionDescriptor> = description.connections;
const applied: undefined = builder.connection.apply([{ connection: contact, closed }]);

void [operations, options, connections, applied];

// @ts-expect-error closed is an SSA bool value, not a JavaScript boolean
builder.connection.apply([{ connection: contact, closed: true }]);
// @ts-expect-error an SSA value is not a connection handle
builder.connection.apply([{ connection: closed, closed }]);
// @ts-expect-error connection.apply returns nothing
const result: Value<'bool'> = builder.connection.apply([{ connection: contact, closed }]);
// @ts-expect-error the plural alias is absent
const plural = builder.connections;
// @ts-expect-error connections are static handles without runtime state
const connectionState = contact.state;
void [plural, connectionState];
// @ts-expect-error the connection option requires a topology
const missingTopology: DeviceInstanceOptions = { instanceId: 'typed', connections: {} };
void [result, missingTopology];
