import { describe, expect, it } from 'vitest';
import { countLines, isUndertaker } from '../src/mr.ts';

describe('mr helpers', () => {
  it('counts GitLab diff lines (the API diff field has no file headers)', () => {
    expect(countLines('@@ -1,3 +1,1 @@\n-a\n-b\n+c\n ctx')).toEqual({
      added: 1,
      removed: 2,
    });
  });

  it('T-F02-AC4: recognises Undertaker by label or by service account', () => {
    const agent = { label: 'undertaker', author_pattern: '^ai-undertaker' };
    const mr = (labels: string[], username: string) => ({ labels, author: { username } }) as never;
    expect(isUndertaker(mr(['undertaker'], 'rayhan'), agent)).toBe(true);
    expect(isUndertaker(mr([], 'ai-undertaker-transcend'), agent)).toBe(true);
    expect(isUndertaker(mr([], 'rayhan'), agent)).toBe(false);
  });
});
