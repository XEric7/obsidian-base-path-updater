import { afterAll, expect, it, vi } from 'vitest';

// Restore window globals after the coordinator's reload and focus-change regression test.
afterAll(() => vi.unstubAllGlobals());

/** Verifies reloads and focus changes preserve write order and recovery after failure. */
it('shares writes across reloads and focus changes and proceeds after failure', async () => {
  vi.stubGlobal('activeWindow', window);
  const app = {};
  const first = await import('../src/write-coordinator');
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const write = first.runWrite(app, async () => {
    await pending;
    throw new Error('Disk full');
  });
  const rejected = expect(write).rejects.toThrow('Disk full');
  vi.stubGlobal('activeWindow', {});
  vi.resetModules();
  const reloaded = await import('../src/write-coordinator');
  const next = vi.fn(async () => 42);
  const result = reloaded.runWrite(app, next);
  await Promise.resolve();
  expect(next).not.toHaveBeenCalled();
  finish();
  await rejected;
  expect(await result).toBe(42);
  await reloaded.waitForWrites(app);
  expect(next).toHaveBeenCalledTimes(1);
});
