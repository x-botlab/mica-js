/** Guest programs used by the playground scenarios. Plain JS: they run in the sandbox worker. */

export const basicsGuest = `
export function setup(ctx) {
  return {
    add(a, b) {
      return a + b;
    },
    async computePi(iterations) {
      const started = performance.now();
      let sum = 0;
      let sign = 1;
      let divisor = 1;
      for (let i = 0; i < iterations; i += 1) {
        sum += sign / divisor;
        sign = -sign;
        divisor += 2;
      }
      return { value: sum * 4, ms: Math.round((performance.now() - started) * 100) / 100, origin: self.origin };
    },
    env() {
      return {
        hasLocalStorage: typeof localStorage,
        hasIndexedDB: typeof indexedDB,
        hasDocument: typeof document,
      };
    },
  };
}
`;

export const capabilityGuest = `
export function setup(ctx) {
  return {
    echo(value) {
      return ctx.invoke('echo', value);
    },
    hostTime() {
      return ctx.invoke('now');
    },
    drawDemo() {
      return ctx.invoke('draw', [
        { x: 12, y: 12, w: 180, h: 28, color: '#3b82f6' },
        { x: 12, y: 52, w: 120, h: 18, color: '#22d3ee' },
        { x: 12, y: 78, w: 220, h: 10, color: '#a3e635' },
      ]);
    },
    unknownCapability() {
      return ctx.invoke('notRegistered');
    },
  };
}
`;

export const offscreen2dGuest = `
export function setup(ctx) {
  const surface = ctx.createSurface();
  const g = surface.canvas.getContext('2d');
  let running = false;
  let phase = 0;
  let frames = 0;
  let lastReport = performance.now();

  function frame() {
    if (!running) return;
    phase += 0.02;
    const w = surface.width;
    const h = surface.height;

    g.fillStyle = '#0b1220';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#1e293b';
    for (let x = 0; x < w; x += 40) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
    for (let x = 0; x < w; x += 4) {
      const y = h / 2 + Math.sin((x + phase * 40) / 40) * h * 0.3;
      g.fillStyle = x > w * 0.5 ? '#22d3ee' : '#3b82f6';
      g.fillRect(x, y - 2, 4, 4);
    }
    surface.commit();

    frames += 1;
    const now = performance.now();
    if (now - lastReport > 500) {
      ctx.emit('fps', Math.round((frames * 1000) / (now - lastReport)));
      frames = 0;
      lastReport = now;
    }

    if (typeof self.requestAnimationFrame === 'function') {
      self.requestAnimationFrame(frame);
    } else {
      setTimeout(frame, 16);
    }
  }

  return {
    start() {
      if (running) return 'already running';
      running = true;
      frame();
      return 'started';
    },
    stop() {
      running = false;
      return 'stopped';
    },
    commitOnce() {
      running = false;
      phase = 0.6;
      running = true;
      frame();
      running = false;
      return 'committed one frame';
    },
    surfaceInfo() {
      return { width: surface.width, height: surface.height, dpr: surface.dpr };
    },
  };
}
`;

export const offscreenWebglGuest = `
export function setup(ctx) {
  const surface = ctx.createSurface();
  const gl = surface.canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
  if (!gl) return { start() { return 'webgl2 unavailable'; }, stop() { return ''; } };

  let running = false;
  let startedAt = performance.now();
  let frames = 0;
  let lastReport = startedAt;

  function frame() {
    if (!running) return;
    const t = (performance.now() - startedAt) / 1000;
    gl.viewport(0, 0, surface.width, surface.height);
    gl.clearColor(0.1 + 0.25 * Math.sin(t), 0.15 + 0.2 * Math.sin(t * 1.7), 0.45 + 0.2 * Math.cos(t), 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    surface.commit();

    frames += 1;
    const now = performance.now();
    if (now - lastReport > 500) {
      ctx.emit('fps', Math.round((frames * 1000) / (now - lastReport)));
      frames = 0;
      lastReport = now;
    }
    setTimeout(frame, 16);
  }

  return {
    start() {
      if (running) return 'already running';
      running = true;
      startedAt = performance.now();
      frame();
      return 'started (WebGL2)';
    },
    stop() {
      running = false;
      return 'stopped';
    },
  };
}
`;

export const eventsGuest = `
export function setup(ctx) {
  let ticks = 0;
  let lastTick = null;

  ctx.on('tick', (payload) => {
    ticks += 1;
    lastTick = payload;
  });
  ctx.handle('reset', () => {
    ticks = 0;
  });

  return {
    stats() {
      return { ticks, lastTick };
    },
    shout(message) {
      ctx.emit('shout', { message, at: Date.now() });
      return 'shouted "' + message + '"';
    },
    logStuff() {
      ctx.log('structured guest log', { ticks });
      console.warn('guest warning');
      console.error('guest error level');
      return 'logged 3 entries';
    },
  };
}
`;

export const errorsGuest = `
export function setup() {
  return {
    boom() {
      throw new Error('guest exploded');
    },
    unhandled() {
      setTimeout(() => {
        throw new Error('async guest error');
      }, 0);
      return 'scheduled';
    },
    async rejects() {
      await Promise.reject(new Error('guest rejected a promise'));
    },
  };
}
`;

export const brokenGuest = `
export function setup( {
  this is not valid javascript
`;

export const spinGuest = `
export function setup() {
  return {
    spin() {
      for (;;) {
        // Deliberately hangs the worker thread.
      }
    },
    ok() {
      return 'alive';
    },
  };
}
`;

export const isolationGuest = `
export function setup() {
  const report = {
    origin: self.origin,
    hasLocalStorage: typeof localStorage,
    hasDocument: typeof document,
    hasIndexedDB: typeof indexedDB,
  };

  return {
    async probe() {
      try {
        await fetch('https://example.com');
        report.fetch = 'allowed';
      } catch (error) {
        report.fetch = 'blocked (' + (error && error.name) + ')';
      }
      try {
        indexedDB.open('mica-probe');
        report.indexedDB = 'allowed';
      } catch (error) {
        report.indexedDB = 'blocked (' + (error && error.name) + ')';
      }
      try {
        report.cookies = String(self.document);
      } catch (error) {
        report.cookies = 'blocked (' + (error && error.name) + ')';
      }
      return report;
    },
  };
}
`;

export const classicGuest = `
self.MicaGuest = {
  setup: function (ctx) {
    return {
      hello: function (name) {
        return 'hello ' + name + ' from a classic script (origin ' + self.origin + ')';
      },
    };
  },
};
`;
