import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // probation/test/e2e spawns the real CLIs against probation/sim/gitlab-fake.ts; its timeouts are set per suite.
    include: ['app/test/**/*.test.ts', 'probation/test/**/*.test.ts', 'probation/test/e2e/**/*.test.ts'],
  },
});
