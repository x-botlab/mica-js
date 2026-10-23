import { describe, expect, it } from 'vitest';
import { SCENARIOS, scenarioById } from './scenarios';
import { SimulationSession, STEP_PS } from './session';

/** The simulation layer is DOM-free, so the whole bench contract is testable in node. */
describe('simulation session', () => {
  it('loads every committed example through the executor host wiring', async () => {
    for (const scenario of SCENARIOS) {
      const session = new SimulationSession(scenario);
      await session.load();
      try {
        const snapshot = session.getSnapshot();
        expect(snapshot.phase, scenario.id).toBe('ready');
        expect(snapshot.state, scenario.id).toBe('ready');
        expect(snapshot.capabilities.length, scenario.id).toBeGreaterThan(0);
      } finally {
        session.dispose();
      }
    }
  });

  it('reports the reset lifecycle each model actually declares', async () => {
    const expected: Readonly<Record<string, Readonly<Record<string, string>>>> = {
      button: { S1: 'supported' },
      relay: { S1: 'supported', K1: 'unsupported' },
      mcu: { U1: 'unsupported' },
    };
    for (const scenario of SCENARIOS) {
      const session = new SimulationSession(scenario);
      await session.load();
      try {
        const actual = Object.fromEntries(
          session.getSnapshot().capabilities.map((row) => [row.label, row.reset]),
        );
        expect(actual, scenario.id).toEqual(expected[scenario.id]);
      } finally {
        session.dispose();
      }
    }
  });

  it('exposes only topic ports the models really declare', async () => {
    const button = new SimulationSession(scenarioById('button'));
    await button.load();
    expect(button.getSnapshot().topics).toEqual(['S1.pressed']);
    button.dispose();

    const relay = new SimulationSession(scenarioById('relay'));
    await relay.load();
    // The relay itself declares no topic port; only the button it is wired to does.
    expect(relay.getSnapshot().topics).toEqual(['S1.pressed']);
    expect(relay.getSnapshot().capabilities.map((row) => row.ports.length)).toEqual([1, 0]);
    relay.dispose();

    const mcu = new SimulationSession(scenarioById('mcu'));
    await mcu.load();
    expect(mcu.getSnapshot().topics).toEqual(['U1.firmwarePatch']);
    mcu.dispose();
  });

  it('drives the button → relay chain on the virtual clock', async () => {
    const session = new SimulationSession(scenarioById('relay'));
    await session.load();
    try {
      expect(session.pressInput('press', true)).toBe(true);
      session.step();
      expect(session.getSnapshot().simTime).toBe(STEP_PS);
      const probes = Object.fromEntries(
        session.getSnapshot().probes.map((probe) => [probe.id, probe.value]),
      );
      expect(probes).toMatchObject({ coil: '1', normallyOpen: 'closed', normallyClosed: 'open' });

      session.reset();
      expect(session.getSnapshot().simTime).toBe(0);
      expect(session.getSnapshot().probes.find((probe) => probe.id === 'normallyOpen')?.value).toBe(
        'open',
      );
    } finally {
      session.dispose();
    }
  });

  it('produces identical traces when every scenario is loaded and replayed twice', async () => {
    for (const scenario of SCENARIOS) {
      const session = new SimulationSession(scenario);
      await session.load();
      try {
        const result = await session.replay();
        expect(result.equal, scenario.id).toBe(true);
        expect(result.entries, scenario.id).toBeGreaterThan(0);
        expect(result.digests[0], scenario.id).toBe(result.digests[1]);
      } finally {
        session.dispose();
      }
    }
  }, 30_000);

  it('rejects a payload the port type does not accept without faulting the executor', async () => {
    const session = new SimulationSession(scenarioById('mcu'));
    await session.load();
    try {
      expect(session.sendUnsupportedPayload('firmware')).toBe(true);
      session.step();
      const snapshot = session.getSnapshot();
      // The device layer rejects the value; the scheduler never faulted, so advancing still works.
      expect(snapshot.state).toBe('ready');
      expect(snapshot.simTime).toBe(0);
      expect(snapshot.lastError).toBeDefined();
      expect(snapshot.diagnostics.map((row) => row.code)).toContain('bench/delivery-rejected');
      session.step();
      expect(session.getSnapshot().simTime).toBe(STEP_PS);
    } finally {
      session.dispose();
    }
  });

  it('rejects a malformed firmware draft before it reaches the device', async () => {
    const session = new SimulationSession(scenarioById('mcu'));
    await session.load();
    try {
      expect(session.sendHex('firmware', 'zz')).toBe(false);
      const snapshot = session.getSnapshot();
      expect(snapshot.state).toBe('ready');
      expect(snapshot.diagnostics.map((row) => row.code)).toContain('bench/rejected');
      expect(snapshot.trace.some((entry) => entry.kind === 'input')).toBe(false);
    } finally {
      session.dispose();
    }
  });
});
