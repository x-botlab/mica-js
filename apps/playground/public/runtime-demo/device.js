// Generated from model.ddl with @mica-js/ddl compileDDL; keep the model in sync with that source.
export const model = {
  kind: 'device',
  name: 'Echo',
  declarations: [
    {
      kind: 'pin',
      name: 'IN',
      source: {
        uri: 'mica:devices/echo/model.ddl',
        range: {
          start: {
            line: 2,
            column: 3,
          },
          end: {
            line: 2,
            column: 10,
          },
        },
      },
    },
    {
      kind: 'pin',
      name: 'OUT',
      source: {
        uri: 'mica:devices/echo/model.ddl',
        range: {
          start: {
            line: 3,
            column: 3,
          },
          end: {
            line: 3,
            column: 11,
          },
        },
      },
    },
  ],
  source: {
    uri: 'mica:devices/echo/model.ddl',
    range: {
      start: {
        line: 1,
        column: 1,
      },
      end: {
        line: 4,
        column: 2,
      },
    },
  },
};

/** The adapter buffers input until the next simulation boundary. */
export function create(ctx) {
  let value = false;
  const subscription = ctx.topics.onDidReceive(({ topic, payload }) => {
    if (topic === 'in') value = Boolean(payload);
  });
  return {
    sync() {
      ctx.topics.publish('out', value);
    },
    dispose() {
      subscription.dispose();
    },
  };
}
