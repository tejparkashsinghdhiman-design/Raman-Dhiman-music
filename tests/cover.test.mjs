import test from 'node:test';
import assert from 'node:assert/strict';
import { coverURL, coverFor } from '../js/cover.js';

test('generated covers are safe inside CSS url(...) and HTML attributes', () => {
  for (const seed of ['raman-dhiman-portrait', 'panjab', 'fame', 'x']) {
    const url = coverURL(seed);
    assert.match(url, /^data:image\/svg\+xml;charset=utf-8,/);
    assert.doesNotMatch(url, /['"<>\s]/, `unsafe character in cover for "${seed}"`);
  }
});

test('covers are deterministic and real artwork wins', () => {
  assert.equal(coverURL('panjab'), coverURL('panjab'));
  assert.notEqual(coverURL('panjab'), coverURL('fame'));
  assert.equal(coverFor({ id: 'panjab', cover: 'assets/covers/panjab.jpg' }), 'assets/covers/panjab.jpg');
});
