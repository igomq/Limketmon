import assert from 'node:assert/strict';
import test from 'node:test';
import manifest from '../lib/data/cards.curated.json' with { type: 'json' };
import { selectCards, projectedPosition, cardTitle, type CollectionFilter } from '../lib/collection.ts';
import type { Card } from '../lib/cards.ts';

test('collection filters combine, preserve source order, and sort recent acquisitions', () => {
  const cards = manifest.cards as Card[];
  const original = cards.map((card) => card.id);
  const inventory = [
    { cardId: cards[0].id, firstObtainedAt: '2026-09-01T00:00:00Z' },
    { cardId: cards[8].id, firstObtainedAt: '2026-09-02T00:00:00Z' }
  ];
  const filter: CollectionFilter = { query: '', rarity: 'all', ownership: 'all', sort: 'rarity' };
  assert.equal(selectCards(cards, inventory, filter)[0].rarity, 'UR');
  assert.deepEqual(selectCards(cards, inventory, { ...filter, query: '  설원 방향 ' }).map((c) => c.version), [9]);
  assert.equal(selectCards(cards, inventory, { ...filter, query: '009' }).length, 1);
  assert.equal(selectCards(cards, inventory, { ...filter, rarity: 'UR', ownership: 'owned' }).length, 0);
  assert.equal(selectCards(cards, inventory, { ...filter, ownership: 'missing' }).length, cards.length - 2);
  assert.deepEqual(selectCards(cards, inventory, { ...filter, ownership: 'owned', sort: 'recent' }).map((c) => c.version), [9, 1]);
  assert.deepEqual(cards.map((card) => card.id), original);
  assert.equal(cardTitle(cards[0]), '미간 최종보스');
  assert.equal(projectedPosition(50, 0), 50);
  assert.ok(projectedPosition(20, 700) > 140);
  assert.ok(projectedPosition(80, -700) < 0, 'reversing velocity must reverse the projected endpoint');
});
