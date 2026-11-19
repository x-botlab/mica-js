/**
 * Serializes asynchronous host operations in call order.
 *
 * Opening a workbench disposes the previous session and creates a new one, so two opens must never
 * overlap: overlapping calls would leak a session whose worker and HTML-view environments are no
 * longer reachable. The queue continues after a rejected task; callers keep their own error path.
 */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task, task);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
