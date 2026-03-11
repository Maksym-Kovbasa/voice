import { describe, expect, it } from 'vitest';

import { removeProfileFieldValue } from './mongo-memory';

describe('removeProfileFieldValue', () => {
  it('removes normalized recommended links', () => {
    const fields = {
      recommended_links: ['Movie Midsommar, link imdb.com/title/tt8772262', 'Dark ||| https://flutter.dev'],
    };

    const next = removeProfileFieldValue(fields, 'recommended_links', 'https://imdb.com/title/tt8772262');
    expect(next.recommended_links).toEqual(['Dark ||| https://flutter.dev']);

    const next2 = removeProfileFieldValue(next, 'recommended_links', 'flutter.dev');
    expect(next2.recommended_links).toBeUndefined();
  });

  it('matches case-insensitively', () => {
    const fields = {
      recommended_links: ['HTTPS://EXAMPLE.COM/TEST'],
    };

    const next = removeProfileFieldValue(fields, 'recommended_links', 'https://example.com/test');
    expect(next.recommended_links).toBeUndefined();
  });
});
