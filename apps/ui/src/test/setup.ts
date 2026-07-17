import '@/i18n';
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// Tests run file-parallel across workers; on a loaded box (CI running api + ui
// + typecheck at once) a `findBy*`/`waitFor` can take longer than RTL's 1000ms
// default and spuriously time out. Give async utils headroom so contention
// slows tests instead of failing them. This is the real fix for the U18/auth
// suite flakiness, not a retry (which just hides it).
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
});
