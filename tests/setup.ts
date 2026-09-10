import { vi } from 'vitest';

// Provide a stable main-window registry for browser-dependent modules in Node tests.
vi.stubGlobal('window', {});
