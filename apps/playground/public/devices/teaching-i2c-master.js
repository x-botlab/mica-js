export default function createTeachingI2cMaster({ electrical }) {
  for (const name of ['SDA', 'SCL']) {
    electrical.initializePin(name, {
      input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 },
      drive: { reference: { source: 'VDD' }, highResistance: 50, lowResistance: 50 },
    });
  }
  return {
    initialize(api) {
      const b = api.builder;
      for (const name of ['SDA', 'SCL']) {
        api.pin(name).configure(2);
        api.pin(name).setOutputEnabled(b.const('bool', true));
        api.pin(name).writeDigital(b.const('bool', true));
      }
    },
    tick(api) {
      const b = api.builder;
      const u = (n) => b.const('u32', n);
      const yes = b.const('bool', true);
      const no = b.const('bool', false);
      const load = (name) => api.state(name).load();
      const store = (name, value) => api.state(name).store(value);
      const phase = load('phase');
      const due = b.int.cmp('eq', load('divider'), u(9));
      const at = (n) => b.bool.and(due, b.int.cmp('eq', phase, u(n)));
      const ack = b.bool.and(
        api.pin('SCL').sampleDigital(),
        b.bool.not(api.pin('SDA').sampleDigital()),
      );
      const addressAck = at(20);
      const dataAck = at(38);
      const addressFailed = b.bool.and(addressAck, b.bool.not(ack));
      const increment = (name, condition) =>
        store(name, b.int.add(load(name), b.select(condition, u(1), u(0))));
      increment('addressAcks', b.bool.and(addressAck, ack));
      increment('dataAcks', b.bool.and(dataAck, ack));
      increment('nacks', b.bool.and(b.bool.or(addressAck, dataAck), b.bool.not(ack)));
      const success = b.bool.and(load('addressAck'), load('dataAck'));
      const complete = b.bool.and(at(40), success);
      increment('sentCount', complete);
      store('lastSent', b.select(complete, load('byte'), load('lastSent')));
      store(
        'byte',
        b.select(complete, b.int.and(b.int.add(load('byte'), u(1)), u(255)), load('byte')),
      );
      store('addressAck', b.select(at(1), no, b.select(addressAck, ack, load('addressAck'))));
      store('dataAck', b.select(at(1), no, b.select(dataAck, ack, load('dataAck'))));

      let sda = api.pin('SDA').readDrivenDigital();
      let scl = api.pin('SCL').readDrivenDigital();
      const drive = (p, data, clock) => {
        sda = b.select(at(p), data, sda);
        scl = b.select(at(p), clock, scl);
      };
      drive(0, yes, yes);
      drive(1, no, yes); // START: SDA falls while SCL is high.
      for (let bit = 0; bit < 8; bit++) {
        // Address 0x42, MSB first, followed by the write bit: 0x84.
        drive(2 + 2 * bit, b.const('bool', ((0x84 >> (7 - bit)) & 1) !== 0), no);
        drive(3 + 2 * bit, sda, yes);
      }
      drive(18, yes, no); // Release SDA for the slave's address ACK.
      drive(19, yes, yes);
      for (let bit = 0; bit < 8; bit++) {
        const data = b.int.cmp('ne', b.int.and(load('byte'), u(1 << (7 - bit))), u(0));
        drive(20 + 2 * bit, data, no);
        drive(21 + 2 * bit, sda, yes);
      }
      drive(36, yes, no);
      drive(37, yes, yes);
      drive(38, no, no); // ACK is sampled before lowering SCL.
      drive(39, no, yes);
      drive(40, yes, yes); // STOP: SDA rises while SCL is high.
      sda = b.select(addressFailed, no, sda);
      // SDA/SCL writes are atomic, and HIGH means released, never driven high.
      api.writeDigitalGroup(['SDA', 'SCL'], [sda, scl]);
      // WidgetHost's existing 25 ms clock: 10 ticks = 250 ms per half-cycle.
      store('divider', b.select(due, u(0), b.int.add(load('divider'), u(1))));
      const next = b.select(b.int.cmp('eq', phase, u(44)), u(1), b.int.add(phase, u(1)));
      store('phase', b.select(addressFailed, u(39), b.select(due, next, phase)));
    },
    flushOutputs(io) {
      io.publish('sent', io.readState('lastSent'));
      io.publish('count', io.readState('sentCount'));
      io.publish('addressAcks', io.readState('addressAcks'));
      io.publish('dataAcks', io.readState('dataAcks'));
      io.publish('nacks', io.readState('nacks'));
    },
  };
}
