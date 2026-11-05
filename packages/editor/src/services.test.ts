import { describe, expect, it } from 'vitest';
import { Commands } from './commands';

describe('Commands', () => {
  it('snapshots command registrations', async () => {
    const service = new Commands();
    const command = { id: 'original', execute: () => 1 };
    const registration = service.register(command);
    command.id = 'changed';
    command.execute = () => 2;
    await expect(service.execute('original')).resolves.toBe(1);
    registration.dispose();
    await expect(service.execute('original')).rejects.toThrow('Unknown command');
  });

  it('executes sync and async handlers and forwards errors', async () => {
    const service = new Commands();
    service.register({ id: 'sum', execute: (...values) => Number(values[0]) + Number(values[1]) });
    service.register({ id: 'async', execute: async () => 'done' });
    service.register({
      id: 'throw',
      execute: () => {
        throw new Error('failure');
      },
    });
    await expect(service.execute('sum', 2, 3)).resolves.toBe(5);
    await expect(service.execute('async')).resolves.toBe('done');
    await expect(service.execute('throw')).rejects.toThrow('failure');
    await expect(service.execute('missing')).rejects.toThrow('Unknown command');
  });

  it('checks registration and releases registrations without removing replacements', async () => {
    const service = new Commands();
    const command = { id: 'test', execute: () => 1 };
    const subscription = service.register(command);
    expect(() => service.register(command)).toThrow('Duplicate command');
    expect(() => service.register({ id: ' ', execute: () => 0 })).toThrow('empty');
    subscription.dispose();
    service.register({ id: 'test', execute: () => 2 });
    subscription.dispose();
    await expect(service.execute('test')).resolves.toBe(2);
    service.dispose();
    service.dispose();
    expect(() => service.register(command)).toThrow('disposed');
    await expect(service.execute('test')).rejects.toThrow('disposed');
  });
});
