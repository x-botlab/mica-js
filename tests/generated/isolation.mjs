import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout, clearTimeout } from 'node:timers';

function remoteError(record) {
  const error = new Error(record.message);
  error.name = record.name;
  if (record.stack) error.stack = record.stack;
  return error;
}

// The property runner stays outside the process executing the SUT, so even a
// synchronous infinite loop can time out and be retried during shrinking.
export class Probe {
  constructor(domain, timeout) {
    this.domain = domain;
    this.timeout = timeout;
    this.child = null;
    this.output = '';
  }

  async start() {
    if (this.child) return;
    const child = fork(new URL('./probe.mjs', import.meta.url), [this.domain], {
      execArgv: ['--max-old-space-size=512'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'advanced',
    });
    this.child = child;
    this.output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        this.output = (this.output + chunk.toString()).slice(-8192);
      });
    }
    try {
      await this.exchange(child, null, 30_000, 'adapter initialization');
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  exchange(child, sample, timeout, operation) {
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('error', onError);
        child.off('exit', onExit);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error) => finish(error);
      const onExit = (code, signal) =>
        finish(
          new Error(
            `Isolated ${this.domain} process exited (${signal ?? code}) during ${operation}\n${this.output}`,
          ),
        );
      const onMessage = (message) => {
        if (message.type === 'initialization-error' || message.ok === false) {
          finish(remoteError(message.error));
        } else if (message.type === 'ready' || message.type === 'result') finish();
      };
      const timer = setTimeout(
        () => finish(new Error(`Isolated ${this.domain} ${operation} exceeded ${timeout}ms`)),
        timeout,
      );
      child.once('error', onError);
      child.once('exit', onExit);
      child.on('message', onMessage);
      if (sample !== null)
        child.send({ sample }, (error) => {
          if (error) finish(error);
        });
    });
  }

  async run(sample) {
    await this.start();
    try {
      await this.exchange(this.child, sample, this.timeout, 'generated sample');
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
  }
}
