import assert from 'node:assert/strict';
import test from 'node:test';
import manifest from '../lib/data/cards.curated.json' with { type: 'json' };
import {
  ACHIEVEMENTS,
  achievementById,
  achievementClaimKey,
  evaluateAchievements,
  type AchievementProgress
} from '../lib/achievements.ts';
import type { Card } from '../lib/cards.ts';
import { DAILY_REWARD_CREDITS, dailyChallenge, dailyClaimKey } from '../lib/daily.ts';
import {
  DECK_NAME_MAX,
  DECK_SIZE,
  MAX_DECKS,
  isDuplicateCardList,
  normalizeDeckName,
  validateDeck
} from '../lib/decks.ts';
import { planBattleRewards, pveFirstClearClaimKey } from '../lib/rewards.ts';
import { kstDate } from '../lib/rules.ts';
import { summarizeBattles, type BattleRow } from '../lib/stats.ts';

const cards = manifest.cards as Card[];
const rarityById: Record<string, string> = Object.fromEntries(cards.map((card) => [card.id, card.rarity]));
const idsOf = (rarity: string, count: number) =>
  cards.filter((card) => card.rarity === rarity).slice(0, count).map((card) => card.id);
const allOwned = new Set(cards.map((card) => card.id));
const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- decks

test('deck limits are stable', () => {
  assert.equal(DECK_SIZE, 3);
  assert.equal(MAX_DECKS, 10);
  assert.equal(DECK_NAME_MAX, 24);
});

test('validateDeck requires exactly three owned cards', () => {
  const [a, b, c] = idsOf('N', 3);
  assert.deepEqual(validateDeck([a, b, c], allOwned), { ok: true, cards: [a, b, c] });
  const short = validateDeck([a, b], allOwned);
  assert.equal(short.ok, false);
  assert.match(short.ok === false ? short.error : '', /정확히 3장/);
  assert.equal(validateDeck([a, b, c, a], allOwned).ok, false);
  assert.equal(validateDeck('abc', allOwned).ok, false);
  assert.equal(validateDeck(undefined, allOwned).ok, false);
  assert.equal(validateDeck([a, b, 3], allOwned).ok, false);
});

test('validateDeck rejects duplicates and unowned cards', () => {
  const [a, b] = idsOf('N', 2);
  const duplicate = validateDeck([a, a, b], allOwned);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.ok === false ? duplicate.error : '', /중복/);
  assert.equal(isDuplicateCardList([a, b]), false);
  assert.equal(isDuplicateCardList([a, a]), true);

  const unowned = validateDeck([a, b, 'imsingyu-v999'], allOwned);
  assert.equal(unowned.ok, false);
  assert.match(unowned.ok === false ? unowned.error : '', /보유하지 않은 카드/);

  const partial = new Set([a, b]);
  const third = idsOf('N', 3)[2];
  assert.equal(validateDeck([a, b, third], partial).ok, false);
  assert.equal(validateDeck([a, b, third], allOwned).ok, true);
});

test('validateDeck enforces the rarity cap in both directions', () => {
  // rarityRank: UR=0, SSR=1, SR=2, R=3, N=4. A cap means "this rarity or weaker",
  // so an R cap admits N/R and rejects SR-or-better.
  const [n1, n2, n3] = idsOf('N', 3);
  const r = idsOf('R', 1)[0];
  const [sr1, sr2] = idsOf('SR', 2);
  const ssr = idsOf('SSR', 1)[0];
  const ur = idsOf('UR', 1)[0];

  assert.deepEqual(validateDeck([n1, n2, r], allOwned, { maxRarity: 'R' }), {
    ok: true,
    cards: [n1, n2, r]
  });
  assert.equal(validateDeck([n1, n2, n3], allOwned, { maxRarity: 'N' }).ok, true);
  assert.equal(validateDeck([n1, n2, sr1], allOwned, { maxRarity: 'R' }).ok, false);
  assert.equal(validateDeck([n1, n2, ssr], allOwned, { maxRarity: 'R' }).ok, false);
  assert.equal(validateDeck([ur, ssr, r], allOwned, { maxRarity: 'R' }).ok, false);
  assert.equal(validateDeck([n1, n2, r], allOwned, { maxRarity: 'N' }).ok, false);
  assert.equal(validateDeck([sr1, sr2, r], allOwned, { maxRarity: 'SR' }).ok, true);
  assert.equal(validateDeck([ur, ssr, sr1], allOwned, { maxRarity: 'UR' }).ok, true);
  const capped = validateDeck([n1, n2, ur], allOwned, { maxRarity: 'R' });
  assert.match(capped.ok === false ? capped.error : '', /R 등급 이하/);
  // no cap = no rarity pressure
  assert.equal(validateDeck([ur, ssr, n1], allOwned).ok, true);
});

test('normalizeDeckName trims, caps length and maps empties to null', () => {
  assert.equal(normalizeDeckName('  강철 덱  '), '강철 덱');
  assert.equal(normalizeDeckName('x'.repeat(40))?.length, DECK_NAME_MAX);
  assert.equal(normalizeDeckName(''), null);
  assert.equal(normalizeDeckName('   '), null);
  assert.equal(normalizeDeckName(null), null);
  assert.equal(normalizeDeckName(42), null);
});

// ---------------------------------------------------------------- daily

test('dailyChallenge is a pure function of the KST date', () => {
  assert.deepEqual(dailyChallenge('2026-09-10'), dailyChallenge('2026-09-10'));
  const challenge = dailyChallenge('2026-09-10');
  assert.equal(challenge.id, 'daily-2026-09-10');
  assert.equal(challenge.date, '2026-09-10');
  assert.equal(challenge.rewardCredits, 3);
  assert.equal(DAILY_REWARD_CREDITS, 3);
  assert.equal(dailyClaimKey('2026-09-10'), 'daily:2026-09-10');
  assert.notDeepEqual(challenge, dailyChallenge('2026-09-11'));
  assert.notEqual(dailyChallenge('2026-09-11').id, challenge.id);
  assert.throws(() => dailyChallenge('2026-9-10'));
  assert.throws(() => dailyChallenge('2026-02-30'));
});

test('kstDate boundary: 15:00Z starts the next KST day', () => {
  const before = new Date('2026-09-10T14:59:59Z');
  const after = new Date('2026-09-10T15:00:00Z');
  assert.equal(kstDate(before), '2026-09-10');
  assert.equal(kstDate(after), '2026-09-11');
  assert.equal(dailyChallenge(kstDate(before)).id, 'daily-2026-09-10');
  assert.equal(dailyChallenge(kstDate(after)).id, 'daily-2026-09-11');
});

test('daily rotation covers every rule kind and stays inside the five opponents', () => {
  const opponentIds = ['rookie', 'regular', 'veteran', 'ace', 'boss'];
  const elements = ['light', 'shadow', 'iron', 'nature', 'spark'];
  const dates: string[] = [];
  const kinds = new Set<string>();
  const opponents = new Set<string>();

  for (let day = 0; day < 14; day++) {
    const date = addDays('2026-09-10', day);
    dates.push(date);
    const challenge = dailyChallenge(date);
    kinds.add(challenge.modifier.kind);
    opponents.add(challenge.opponentId);
    assert.ok(opponentIds.includes(challenge.opponentId), challenge.opponentId);
    assert.equal(challenge.id, `daily-${date}`);
    assert.equal(challenge.date, date);
    assert.equal(challenge.rewardCredits, 3);
    assert.ok(challenge.title.length > 0 && challenge.description.length > 0 && challenge.ruleLabel.length > 0);

    const modifier = challenge.modifier;
    if (modifier.kind === 'rarity_cap') {
      assert.equal(challenge.maxRarity, modifier.max);
      assert.ok(modifier.max === 'R' || modifier.max === 'SR');
      assert.match(challenge.ruleLabel, new RegExp(modifier.max));
    } else if (modifier.kind === 'element_boost') {
      assert.equal(challenge.maxRarity, undefined);
      assert.equal(modifier.bonus, 0.25);
      assert.ok(elements.includes(modifier.element));
    } else if (modifier.kind === 'turn_limit') {
      assert.equal(challenge.maxRarity, undefined);
      assert.equal(modifier.turns, 12);
    } else {
      assert.equal(challenge.maxRarity, undefined);
      assert.deepEqual(modifier, { kind: 'none' });
    }
  }

  assert.ok(kinds.size >= 4, `rule kinds: ${[...kinds].join(', ')}`);
  assert.equal(kinds.size, 4);
  assert.ok(opponents.size >= 3, `opponents: ${[...opponents].join(', ')}`);

  // consecutive days differ in both lanes
  for (let day = 1; day < dates.length; day++) {
    const previous = dailyChallenge(dates[day - 1]);
    const current = dailyChallenge(dates[day]);
    assert.notEqual(previous.opponentId, current.opponentId, dates[day]);
    assert.notEqual(previous.modifier.kind, current.modifier.kind, dates[day]);
  }
  assert.deepEqual(dailyChallenge(dates[0]), dailyChallenge('2026-09-10'));
});

// ---------------------------------------------------------------- achievements

const progress = (overrides: Partial<AchievementProgress> = {}): AchievementProgress => ({
  wins: 0,
  losses: 0,
  bossClears: 0,
  dailyClears: 0,
  nOnlyWins: 0,
  clutchWins: 0,
  totalPulls: 0,
  ownedRarities: [],
  ...overrides
});

test('achievement catalog is exactly the eight ids with the fixed rewards', () => {
  assert.deepEqual(
    ACHIEVEMENTS.map((achievement) => achievement.id),
    ['first_win', 'wins_10', 'boss_clear', 'n_only_win', 'clutch_win', 'all_rarities', 'pulls_100', 'daily_3']
  );
  assert.equal(new Set(ACHIEVEMENTS.map((achievement) => achievement.id)).size, 8);
  const rewards: Record<string, number> = {
    first_win: 2,
    wins_10: 5,
    boss_clear: 5,
    n_only_win: 4,
    clutch_win: 4,
    all_rarities: 10,
    pulls_100: 5,
    daily_3: 3
  };
  for (const achievement of ACHIEVEMENTS) {
    assert.equal(achievement.reward, rewards[achievement.id]);
    assert.ok(Number.isInteger(achievement.reward) && achievement.reward > 0);
    assert.ok(achievement.name.length > 0 && achievement.description.length > 0);
  }
  assert.equal(achievementById('boss_clear')?.reward, 5);
  assert.equal(achievementById('missing'), undefined);
  assert.equal(achievementClaimKey('first_win'), 'achievement:first_win');
});

test('achievement thresholds hold exactly at the boundary', () => {
  assert.ok(!evaluateAchievements(progress({ wins: 0 })).includes('first_win'));
  assert.ok(evaluateAchievements(progress({ wins: 1 })).includes('first_win'));
  assert.ok(!evaluateAchievements(progress({ wins: 9 })).includes('wins_10'));
  assert.ok(evaluateAchievements(progress({ wins: 10 })).includes('wins_10'));
  assert.ok(!evaluateAchievements(progress({ dailyClears: 2 })).includes('daily_3'));
  assert.ok(evaluateAchievements(progress({ dailyClears: 3 })).includes('daily_3'));
  assert.ok(!evaluateAchievements(progress({ totalPulls: 99 })).includes('pulls_100'));
  assert.ok(evaluateAchievements(progress({ totalPulls: 100 })).includes('pulls_100'));
  assert.ok(!evaluateAchievements(progress({ bossClears: 0 })).includes('boss_clear'));
  assert.ok(evaluateAchievements(progress({ bossClears: 1 })).includes('boss_clear'));
  assert.deepEqual(evaluateAchievements(progress()), []);
  assert.deepEqual(
    evaluateAchievements(progress({ wins: 1, dailyClears: 3, clutchWins: 1 })),
    ['first_win', 'clutch_win', 'daily_3']
  );
});

test('all_rarities needs all five owned rarities', () => {
  const four = ['N', 'R', 'SR', 'SSR'];
  assert.ok(!evaluateAchievements(progress({ ownedRarities: four })).includes('all_rarities'));
  assert.ok(evaluateAchievements(progress({ ownedRarities: [...four, 'UR'] })).includes('all_rarities'));
  const complete = progress({
    wins: 10,
    bossClears: 1,
    dailyClears: 3,
    nOnlyWins: 1,
    clutchWins: 1,
    totalPulls: 100,
    ownedRarities: ['N', 'R', 'SR', 'SSR', 'UR']
  });
  assert.deepEqual(
    evaluateAchievements(complete),
    ACHIEVEMENTS.map((achievement) => achievement.id)
  );
});

// ---------------------------------------------------------------- rewards

test('a first PvE clear pays, a repeat clear pays nothing', () => {
  const first = planBattleRewards(
    { kind: 'pve', opponentId: 'ace', result: 'won', kstDate: '2026-09-10', firstClear: true },
    7
  );
  assert.deepEqual(first, {
    credits: 7,
    claims: ['pve_first:ace'],
    lines: [{ label: '첫 격파 보상', credits: 7 }]
  });
  const repeat = planBattleRewards(
    { kind: 'pve', opponentId: 'ace', result: 'won', kstDate: '2026-09-10', firstClear: false },
    7
  );
  assert.deepEqual(repeat, { credits: 0, claims: [], lines: [] });
  assert.equal(pveFirstClearClaimKey('ace'), 'pve_first:ace');
  assert.notEqual(pveFirstClearClaimKey('ace'), pveFirstClearClaimKey('boss'));
});

test('a daily win pays three credits with the day claim key', () => {
  const daily = planBattleRewards(
    { kind: 'daily', opponentId: 'boss', result: 'won', kstDate: '2026-09-10', firstClear: false },
    9
  );
  assert.deepEqual(daily, {
    credits: 3,
    claims: ['daily:2026-09-10'],
    lines: [{ label: '데일리 챌린지 보상', credits: 3 }]
  });
  const nextDay = planBattleRewards(
    { kind: 'daily', opponentId: 'boss', result: 'won', kstDate: '2026-09-11', firstClear: false },
    9
  );
  assert.notEqual(daily.claims[0], nextDay.claims[0]);
  // firstClear never adds a PvE claim on top of a daily win
  const dailyFirst = planBattleRewards(
    { kind: 'daily', opponentId: 'boss', result: 'won', kstDate: '2026-09-10', firstClear: true },
    9
  );
  assert.deepEqual(dailyFirst.claims, ['daily:2026-09-10']);
  assert.ok(!dailyFirst.claims.some((claim) => claim.startsWith('pve_first:')));
});

test('losses and draws never pay for either battle kind', () => {
  for (const kind of ['pve', 'daily'] as const) {
    for (const result of ['lost', 'draw'] as const) {
      const plan = planBattleRewards(
        { kind, opponentId: 'rookie', result, kstDate: '2026-09-10', firstClear: true },
        5
      );
      assert.deepEqual(plan, { credits: 0, claims: [], lines: [] }, `${kind}/${result}`);
    }
  }
});

// ---------------------------------------------------------------- stats

const row = (overrides: Partial<BattleRow> = {}): BattleRow => ({
  result: 'lost',
  kind: 'pve',
  opponentId: 'rookie',
  kstDate: '2026-09-10',
  createdAt: '2026-09-10T00:00:00.000Z',
  deckCards: [],
  mvpCardId: null,
  damageDealt: 0,
  ...overrides
});

test('an empty history summarises to zeroes', () => {
  assert.deepEqual(summarizeBattles([], rarityById), {
    battles: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    streak: 0,
    bestStreak: 0,
    topCards: [],
    rarityUsage: {},
    bossClears: 0,
    dailyClears: 0
  });
});

test('streak and bestStreak follow the newest-first order', () => {
  const rows = ['won', 'won', 'lost', 'won', 'won', 'won'].map((result) => row({ result }));
  const summary = summarizeBattles(rows, rarityById);
  assert.equal(summary.streak, 2);
  assert.equal(summary.bestStreak, 3);
  assert.equal(summary.battles, 6);
  assert.equal(summary.wins, 5);
  assert.equal(summary.losses, 1);
  assert.equal(summary.winRate, 83.3);
  assert.equal(summarizeBattles([row({ result: 'draw' })], rarityById).streak, 0);
  assert.equal(
    summarizeBattles([row({ result: 'lost' }), row({ result: 'won' }), row({ result: 'won' })], rarityById)
      .bestStreak,
    2
  );
});

test('win rate rounds to one decimal percent', () => {
  assert.equal(summarizeBattles([row({ result: 'won' }), row(), row()], rarityById).winRate, 33.3);
  assert.equal(
    summarizeBattles([row({ result: 'won' }), row({ result: 'won' }), row()], rarityById).winRate,
    66.7
  );
  assert.equal(summarizeBattles([row(), row()], rarityById).winRate, 0);
});

test('topCards sorts by uses, then wins, then cardId and caps at five', () => {
  const [a, b, c, d, e, f] = [...idsOf('N', 6)].sort();
  const rows = [
    row({ result: 'won', deckCards: [a, b, c] }),
    row({ result: 'won', deckCards: [a, b, d] }),
    row({ result: 'lost', deckCards: [a, e, f] })
  ];
  const { topCards } = summarizeBattles(rows, rarityById);
  assert.deepEqual(topCards, [
    { cardId: a, uses: 3, wins: 2 },
    { cardId: b, uses: 2, wins: 2 },
    { cardId: c, uses: 1, wins: 1 },
    { cardId: d, uses: 1, wins: 1 },
    { cardId: e, uses: 1, wins: 0 }
  ]);
  assert.ok(!topCards.some((entry) => entry.cardId === f));
});

test('rarityUsage counts deck slots and boss/daily counters count wins only', () => {
  const [r1, r2] = idsOf('R', 2);
  const sr = idsOf('SR', 1)[0];
  const rows = [
    row({ result: 'won', kind: 'daily', opponentId: 'boss', deckCards: [r1, sr] }),
    row({ result: 'lost', kind: 'daily', opponentId: 'boss', deckCards: [r1, r2] }),
    row({ result: 'won', kind: 'pve', opponentId: 'boss', deckCards: [r1, sr] }),
    row({ result: 'won', kind: 'pve', opponentId: 'ace', deckCards: [sr] })
  ];
  const summary = summarizeBattles(rows, rarityById);
  assert.deepEqual(summary.rarityUsage, { R: 4, SR: 3 });
  assert.equal(summary.bossClears, 2);
  assert.equal(summary.dailyClears, 1);
  assert.equal(summary.battles, 4);
  assert.equal(summary.streak, 1);
  assert.equal(summary.bestStreak, 2);
  assert.deepEqual(summarizeBattles([row({ deckCards: ['not-a-card'] })], rarityById).rarityUsage, {});
});
