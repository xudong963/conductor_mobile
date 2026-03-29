export class KeyedSerialTaskQueue<Key> {
  private readonly tails = new Map<Key, Promise<void>>();

  run<Value>(key: Key, task: () => Promise<Value> | Value): Promise<Value> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );

    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });

    return current;
  }
}
