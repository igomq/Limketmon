import assert from 'node:assert/strict';
import test from 'node:test';
import manifest from '../lib/data/cards.curated.json' with { type: 'json' };
import type { Card } from '../lib/cards.ts';
import { enhancePower, MAX_ENHANCE } from '../lib/enhance.ts';
import {
  applyTranscend,
  canTranscend,
  clampTraitLevel,
  dismantleReward,
  effectiveCard,
  fragmentChance,
  FRAGMENTS_PER_TWIN_PROOF,
  fusionMinEnhance,
  fusionRarity,
  MAX_RESIST,
  MAX_TRAITS,
  MAX_TRAIT_LEVEL,
  MIN_TRANSCEND_ENHANCE,
  MIN_TRANSCEND_TRAIT_LEVEL,
  nextRarity,
  parseTraits,
  traitCost,
  traitValue,
  TRAIT_IDS,
  TRAIT_LABEL,
  RARITY_STEPS,
  TWIN_PROOF_COST,
  type CardProgress,
  type Trait
} from '../lib/progression.ts';

const cards = manifest.cards as Card[];
const cardOf = (rarity: Card['rarity']) => cards.find((card) => card.rarity === rarity)!;
const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const trait = (partial: Partial<Trait> = {}): Trait => ({ id: 'damage', level: 0, transcended: false, ...partial });

test('the trait catalogue is exactly the seven ids with Korean labels', () => {
  assert.deepEqual(TRAIT_IDS, [
    'damage',
    'synergy',
    'resist_earth',
    'resist_water',
    'resist_fire',
    'resist_grass',
    'resist_dark'
  ]);
  for (const id of TRAIT_IDS) assert.ok(TRAIT_LABEL[id].length > 0);
  assert.equal(MAX_TRAITS, 2);
  assert.equal(MAX_TRAIT_LEVEL, 20);
  assert.equal(FRAGMENTS_PER_TWIN_PROOF, 5);
  assert.equal(MIN_TRANSCEND_ENHANCE, 5);
  assert.equal(MIN_TRANSCEND_TRAIT_LEVEL, 10);
  assert.equal(TWIN_PROOF_COST, 1);
});

test('traitValue is 1% per level plus a 5% step every five, x1.75 transcended', () => {
  const expected: Array<[number, number]> = [
    [0, 0],
    [1, 0.01],
    [4, 0.04],
    [5, 0.1],
    [9, 0.14],
    [10, 0.2],
    [19, 0.34],
    [20, 0.4]
  ];
  for (const [level, value] of expected) near(traitValue(trait({ level })), value);
  // The transcend bonus doubles down on the 5-level steps.
  near(traitValue(trait({ level: 10, transcended: true })), 0.35);
  near(traitValue(trait({ level: 20, transcended: true })), MAX_RESIST);
  // Out-of-range and broken input never escapes 0..20.
  near(traitValue(trait({ level: 99 })), 0.4);
  near(traitValue(trait({ level: -3 })), 0);
  near(traitValue(trait({ level: Number.NaN })), 0);
  assert.equal(clampTraitLevel(7.9), 7);
  assert.equal(clampTraitLevel(Infinity), 0);
  for (let level = 0; level < MAX_TRAIT_LEVEL; level++) {
    assert.ok(traitValue(trait({ level: level + 1 })) > traitValue(trait({ level })), `level ${level}`);
  }
});

test('traitCost uses the rarity base and spikes every fifth level', () => {
  const bases: Array<[Card['rarity'], number]> = [
    ['N', 1],
    ['R', 2],
    ['SR', 3],
    ['SSR', 5],
    ['UR', 8],
    ['XR', 12]
  ];
  for (const [rarity, base] of bases) {
    assert.equal(traitCost(rarity, 0), base, rarity);
    assert.equal(traitCost(rarity, 4), base * 5, rarity);
    assert.equal(traitCost(rarity, 5), base * 11, rarity);
    assert.equal(traitCost(rarity, 10), base * 21, rarity);
    assert.equal(traitCost(rarity, 19), base * 35, rarity);
    assert.equal(traitCost(rarity, 20), base * 41, rarity);
    for (let level = 0; level < MAX_TRAIT_LEVEL; level++) {
      assert.ok(traitCost(rarity, level + 1) > traitCost(rarity, level), `${rarity}@${level}`);
    }
  }
  assert.equal(traitCost('N', -1), traitCost('N', 0));
  assert.equal(traitCost('SR', 99), traitCost('SR', 20));
});

test('parseTraits survives stored JSON, junk ids, duplicates and overflow', () => {
  assert.deepEqual(parseTraits('[]'), []);
  assert.deepEqual(parseTraits('not json'), []);
  assert.deepEqual(parseTraits(null), []);
  assert.deepEqual(parseTraits(42), []);
  assert.deepEqual(parseTraits('[{"id":"damage","level":3,"transcended":false}]'), [
    { id: 'damage', level: 3, transcended: false }
  ]);
  assert.deepEqual(parseTraits([{ id: 'synergy', level: 12, transcended: true }]), [
    { id: 'synergy', level: 12, transcended: true }
  ]);
  // Unknown ids are dropped, the first of a duplicate id wins.
  assert.deepEqual(parseTraits([{ id: 'nope', level: 3 }, { id: 'damage', level: 3 }, { id: 'damage', level: 9 }]), [
    { id: 'damage', level: 3, transcended: false }
  ]);
  // At most two traits per card, levels clamp to 0..20, only a real true marks a transcend.
  assert.deepEqual(
    parseTraits([
      { id: 'damage', level: 3 },
      { id: 'synergy', level: 99, transcended: 1 },
      { id: 'resist_fire', level: -4 }
    ]),
    [
      { id: 'damage', level: 3, transcended: false },
      { id: 'synergy', level: 20, transcended: false }
    ]
  );
  assert.deepEqual(parseTraits(['damage', 7]), []);
});

test('the rarity ladder ends at XR', () => {
  assert.deepEqual(RARITY_STEPS, ['N', 'R', 'SR', 'SSR', 'UR', 'XR']);
  const ladder: Array<[Card['rarity'], Card['rarity'] | null]> = [
    ['N', 'R'],
    ['R', 'SR'],
    ['SR', 'SSR'],
    ['SSR', 'UR'],
    ['UR', 'XR'],
    ['XR', null]
  ];
  for (const [rarity, next] of ladder) assert.equal(nextRarity(rarity), next, rarity);
});

test('dismantling pays proof and fragment odds by rarity, with UR/XR guaranteed', () => {
  const rewards: Array<[Card['rarity'], number, number]> = [
    ['N', 1, 0.01],
    ['R', 3, 0.03],
    ['SR', 6, 0.08],
    ['SSR', 10, 0.2],
    ['UR', 25, 1],
    ['XR', 40, 1]
  ];
  for (const [rarity, proof, chance] of rewards) {
    assert.equal(dismantleReward(rarity), proof, rarity);
    assert.equal(fragmentChance(rarity), chance, rarity);
  }
  for (const rarity of RARITY_STEPS.slice(1)) {
    assert.ok(dismantleReward(rarity) > dismantleReward(RARITY_STEPS[RARITY_STEPS.indexOf(rarity) - 1]!), rarity);
  }
  assert.ok(fragmentChance('UR') <= 1 && fragmentChance('N') > 0);
});

test('fusion promotes three copies one step, never into XR, and two copies keep the rarity', () => {
  assert.equal(fusionRarity('N', 3), 'R');
  assert.equal(fusionRarity('R', 3), 'SR');
  assert.equal(fusionRarity('SR', 3), 'SSR');
  assert.equal(fusionRarity('SSR', 3), 'UR');
  assert.equal(fusionRarity('UR', 3), null);
  assert.equal(fusionRarity('XR', 3), null);
  assert.equal(fusionRarity('SR', 2), 'SR');
  assert.equal(fusionRarity('UR', 2), 'UR');
  assert.equal(fusionRarity('XR', 2), null);
  // 3-card materials need enhance levels from SR up; 2-card fusion has no level requirement.
  assert.deepEqual(
    RARITY_STEPS.map((rarity) => fusionMinEnhance(rarity, 3)),
    [0, 0, 1, 2, 3, 3]
  );
  for (const rarity of RARITY_STEPS) assert.equal(fusionMinEnhance(rarity, 2), 0, rarity);
});

test('transcend needs +5, a non-transcended +10 trait and a card below XR', () => {
  const progress: CardProgress = {
    baseCardId: 'imsingyu-v002',
    rarity: 'N',
    enhanceLevel: 5,
    traits: [trait({ id: 'damage', level: 10 }), trait({ id: 'synergy', level: 9 })]
  };
  assert.equal(canTranscend(progress, 'damage'), true);
  assert.equal(canTranscend({ ...progress, enhanceLevel: 4 }, 'damage'), false);
  assert.equal(canTranscend(progress, 'synergy'), false, 'trait below +10');
  assert.equal(canTranscend(progress, 'resist_fire'), false, 'trait the card does not own');
  assert.equal(canTranscend({ ...progress, traits: [trait({ id: 'damage', level: 20, transcended: true })] }, 'damage'), false);
  assert.equal(canTranscend({ ...progress, rarity: 'XR' }, 'damage'), false);
  assert.equal(canTranscend({ ...progress, rarity: 'UR' }, 'damage'), true);

  const before = JSON.stringify(progress);
  const transcended = applyTranscend(progress, 'damage');
  assert.ok(transcended);
  assert.equal(transcended.rarity, 'R');
  assert.equal(transcended.enhanceLevel, 5, 'enhance survives');
  assert.equal(transcended.baseCardId, progress.baseCardId);
  assert.deepEqual(transcended.traits, [trait({ id: 'damage', level: 10, transcended: true }), trait({ id: 'synergy', level: 9 })]);
  assert.notEqual(transcended.traits, progress.traits, 'traits are copied, not mutated');
  assert.equal(JSON.stringify(progress), before, 'input is untouched');
  assert.equal(applyTranscend({ ...progress, rarity: 'XR' }, 'damage'), null);
  assert.equal(applyTranscend(progress, 'synergy'), null);
});

test('effectiveCard re-labels the owned row and keeps the same-rarity stats', () => {
  const n = cardOf('N');
  const before = JSON.stringify(n);
  const same = effectiveCard(n, 'owned-n', 'N');
  assert.notEqual(same, n);
  assert.deepEqual({ ...same }, { ...n, id: 'owned-n', baseCardId: n.id });
  assert.equal(same.attack, n.attack);
  assert.equal(same.defense, n.defense);
  assert.equal(same.luck, n.luck);
  // Promotion is applied on top of the card's own shape, and the original stays untouched.
  const promoted = effectiveCard(n, 'owned-n-r', 'R');
  near(promoted.attack, Math.round(n.attack * (enhancePower('R', 0) / enhancePower('N', 0))));
  assert.equal(promoted.attack, Math.round(n.attack * 1.25));
  assert.ok(promoted.attack > n.attack && promoted.defense > n.defense && promoted.luck > n.luck);
  assert.equal(promoted.baseCardId, n.id);
  assert.equal(promoted.rarity, 'R');
  assert.equal(JSON.stringify(n), before);
  // Re-deriving keeps the original catalog id, never the previous owned id.
  assert.equal(effectiveCard(promoted, 'owned-n-xr', 'XR').baseCardId, n.id);
});

test('effectiveCard lands XR exactly at UR * 1.35 and climbs every step', () => {
  const n = cardOf('N');
  const ratio = (rarity: Card['rarity']) => enhancePower(rarity, 0) / enhancePower('N', 0);
  near(ratio('XR'), ratio('UR') * 1.35);
  near(effectiveCard(n, 'owned-xr', 'XR').attack, Math.round(n.attack * ratio('XR')));
  let previous = 0;
  for (const rarity of RARITY_STEPS) {
    const stats = effectiveCard(n, 'owned-' + rarity, rarity);
    assert.ok(stats.attack >= n.attack, rarity);
    assert.ok(stats.attack > previous, rarity);
    previous = stats.attack;
  }
  // The same promoted card is always at least as strong as the same card unscaled.
  assert.ok(effectiveCard(n, 'owned-ur', 'UR').attack > effectiveCard(n, 'owned-ssr', 'SSR').attack);
});

test('the power curve carries the rarity self-buff and still grows with every enhance level', () => {
  near(enhancePower('N', 0) / enhancePower('N', 0), 1);
  near(enhancePower('R', 0), 1.25);
  near(enhancePower('SR', 0), 1.55 * 1.03);
  near(enhancePower('SSR', 0), 2.4 * 1.06);
  near(enhancePower('UR', 0), 3.55 * 1.1);
  near(enhancePower('XR', 0), enhancePower('UR', 0) * 1.35);
  for (const rarity of RARITY_STEPS) {
    for (let level = 0; level < MAX_ENHANCE; level++) {
      assert.ok(enhancePower(rarity, level + 1) > enhancePower(rarity, level), `${rarity}@${level}`);
    }
  }
});
