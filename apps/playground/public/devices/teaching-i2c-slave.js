export default function createTeachingI2cSlave({ electrical }) {
  for (const name of ['SDA', 'SCL']) {
    electrical.initializePin(name, {
      input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 },
      drive: { reference: { source: 'VDD' }, highResistance: 50, lowResistance: 50 },
    });
  }
  return {
    initialize(api) {
      for (const name of ['SDA', 'SCL']) {
        api.pin(name).configure(2);
        api.pin(name).setOutputEnabled(api.builder.const('bool', true));
        api.pin(name).writeDigital(api.builder.const('bool', true));
      }
    },
    tick(api) {
      const b = api.builder;
      const u = (n) => b.const('u32', n);
      const yes = b.const('bool', true);
      const no = b.const('bool', false);
      const load = (name) => api.state(name).load();
      const store = (name, value) => api.state(name).store(value);
      const sda = api.pin('SDA').sampleDigital();
      const scl = api.pin('SCL').sampleDigital();
      const previousSda = load('previousSda');
      const previousScl = load('previousScl');
      const stableHigh = b.bool.and(scl, previousScl);
      const start = b.bool.and(stableHigh, b.bool.and(previousSda, b.bool.not(sda)));
      const stop = b.bool.and(stableHigh, b.bool.and(b.bool.not(previousSda), sda));
      const rising = b.bool.and(b.bool.not(previousScl), scl);
      const falling = b.bool.and(previousScl, b.bool.not(scl));
      const active = load('active');
      const stage = load('ackStage');
      const address = load('address');
      const sample = b.bool.and(b.bool.and(active, rising), b.int.cmp('eq', stage, u(0)));
      const shifted = b.int.or(b.int.shl(load('shift'), u(1)), b.select(sda, u(1), u(0)));
      const full = b.bool.and(sample, b.int.cmp('eq', load('bits'), u(7)));
      const match = b.int.cmp('eq', shifted, u(0x84));
      const selected = load('selected');
      const received = b.bool.and(full, b.bool.and(b.bool.not(address), selected));
      const beginAck = b.bool.and(b.bool.and(active, falling), b.int.cmp('eq', stage, u(1)));
      const endAck = b.bool.and(b.bool.and(active, falling), b.int.cmp('eq', stage, u(2)));
      const increment = (name, condition) =>
        store(name, b.int.add(load(name), b.select(condition, u(1), u(0))));
      increment('starts', start);
      increment('stops', b.bool.and(stop, active));
      increment('receivedCount', received);
      increment('addressAcks', b.bool.and(beginAck, b.bool.and(address, load('ackPending'))));
      increment(
        'dataAcks',
        b.bool.and(beginAck, b.bool.and(b.bool.not(address), load('ackPending'))),
      );
      store('received', b.select(received, shifted, load('received')));
      store('selected', b.select(start, no, b.select(b.bool.and(full, address), match, selected)));
      store('ackPending', b.select(full, b.select(address, match, selected), load('ackPending')));
      store('address', b.select(start, yes, b.select(endAck, no, address)));
      store(
        'bits',
        b.select(
          b.bool.or(start, endAck),
          u(0),
          b.select(sample, b.int.add(load('bits'), u(1)), load('bits')),
        ),
      );
      store(
        'shift',
        b.select(b.bool.or(start, endAck), u(0), b.select(sample, shifted, load('shift'))),
      );
      store(
        'ackStage',
        b.select(
          b.bool.or(start, stop),
          u(0),
          b.select(full, u(1), b.select(beginAck, u(2), b.select(endAck, u(0), stage))),
        ),
      );
      store('active', b.select(start, yes, b.select(stop, no, active)));
      // Only the falling edges around the ninth clock assert/release ACK.
      // No master state, clock phase, or byte is visible to this device.
      const release = b.bool.or(b.bool.or(start, stop), endAck);
      api
        .pin('SDA')
        .writeDigital(
          b.select(
            release,
            yes,
            b.select(beginAck, b.bool.not(load('ackPending')), api.pin('SDA').readDrivenDigital()),
          ),
        );
      store('previousSda', sda);
      store('previousScl', scl);
    },
    flushOutputs(io) {
      io.publish('received', io.readState('received'));
      io.publish('count', io.readState('receivedCount'));
      io.publish('addressAcks', io.readState('addressAcks'));
      io.publish('dataAcks', io.readState('dataAcks'));
      io.publish('starts', io.readState('starts'));
      io.publish('stops', io.readState('stops'));
    },
  };
}
