import { expect, it, vi } from 'vitest';

it('shares outstanding writes across module reloads and lets later writes proceed after failure', async () => {
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
