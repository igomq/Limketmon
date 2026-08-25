import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureRarityCoverage, generateCard, rarityFromRoll } from '../lib/card-gen.ts';

const base = { imageKey: 'v001.jpg', sourceName: 'TalkMedia_i_0ad1e38c341b.jpg.jpg', version: 1 };

test('card generation stays deterministic and covers every rarity', () => {
  assert.deepEqual(generateCard(base), generateCard(base));
  assert.deepEqual(
    [0, 0.5, 0.77, 0.91, 0.98].map(rarityFromRoll),
    ['N', 'R', 'SR', 'SSR', 'UR']
  );

  const cards = Array.from({ length: 45 }, (_, index) =>
    generateCard({ imageKey: `v${index}.jpg`, sourceName: `img${index}.jpg`, version: index + 1 })
  );
  ensureRarityCoverage(cards);
  assert.deepEqual(new Set(cards.map((card) => card.rarity)), new Set(['N', 'R', 'SR', 'SSR', 'UR']));
});
