// Keep outstanding writes visible even when Obsidian reloads the plugin module.
const registryKey = Symbol.for('base-path-updater.pending-writes');
const host = globalThis as typeof globalThis & {
  [registryKey]?: WeakMap<object, Promise<void>>;
};
const pendingWrites = (host[registryKey] ??= new WeakMap<object, Promise<void>>());

/** Returns a promise that settles after previously submitted writes for the supplied app finish. */
export function waitForWrites(app: object): Promise<void> {
  return pendingWrites.get(app) ?? Promise.resolve();
}

/** Serializes the supplied write for an app and returns its result, preserving failures for the caller. */
export function runWrite<T>(app: object, write: () => Promise<T>): Promise<T> {
  const result = waitForWrites(app).then(write);
  const settled = result.then(
    () => {},
    () => {},
  );
  pendingWrites.set(app, settled);
  void settled.then(() => {
    if (pendingWrites.get(app) === settled) pendingWrites.delete(app);
  });
  return result;
}
