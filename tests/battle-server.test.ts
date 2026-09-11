// Server-authority tests for decks, battles and rewards, run against the shipped migrations on an
// in-memory SQLite that mimics the D1 binding.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { createD1, migrate } from './helpers/d1.mjs';

const USER = 'user_a';
const OTHER = 'user_b';
const db = createD1();
// Every shipped migration, in order, so the tests always run against the real schema.
const migrationDir = new URL('../drizzle/', import.meta.url);
for (const file of readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()) {
  migrate(db, readFileSync(new URL(file, migrationDir), 'utf8'));
}

// The Workers runtime injects the D1 binding; the stub module exposes the same object.
const { env } = await import('./helpers/cloudflare-workers.mjs');
env.DB = db;

const game = await import('../lib/game.ts');
const { OPPONENTS, opponentById } = await import('../lib/battle/opponents.ts');
const { runBattle } = await import('../lib/battle/simulate.ts');
const { advance, createBattle } = await import('../lib/battle/engine.ts');
const { aiDecision } = await import('../lib/battle/ai.ts');
const { dailyChallenge } = await import('../lib/daily.ts');
const { BATTLE_RULESET_VERSION } = await import('../lib/battle/types.ts');
const { kstDate } = await import('../lib/rules.ts');
const { cardIdsByRarity, seedOwned } = await import('./helpers/seed.ts');

const DAY = new Date('2026-09-10T03:00:00Z');

function reset() {
  for (const table of ['reward_claims', 'user_achievements', 'battles', 'deck_cards', 'decks', 'inventory', 'pull_history', 'coupon_redemptions', 'user_game_state', 'users']) {
    db.exec(`DELETE FROM ${table}`);
  }
  for (const [id, email] of [[USER, 'a@local.invalid'], [OTHER, 'b@local.invalid']]) {
    db.exec(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('${id}', '${email}', 'now', 'now')`);
    db.exec(`INSERT INTO user_game_state (user_id, pull_credits, last_free_pull_date, pity_counter) VALUES ('${id}', 0, NULL, 0)`);
  }
}

test('battles are server-authoritative: ownership, verification, first-clear reward, idempotency', async () => {
  reset();
  seedOwned(db, USER, cardIdsByRarity({ N: 3, R: 3, SR: 1, SSR: 1, UR: 1 }));

  // Controlled owned growth makes this a settlement test independent of seed luck.
  db.exec(`UPDATE inventory SET enhance_level = 15 WHERE user_id = '${USER}'`);
  const owned = cardIdsByRarity({ R: 3 });
  await assert.rejects(game.createDeck(USER, '도둑 덱', cardIdsByRarity({ SSR: 2, UR: 1 })), /보유하지 않은 카드/);
  await assert.rejects(game.createDeck(USER, '중복 덱', [owned[0], owned[0], owned[1]]), /중복/);
  await assert.rejects(game.createDeck(USER, '짧은 덱', owned.slice(0, 2)), /3장/);
  const decks = await game.createDeck(USER, '첫 덱', owned);
  assert.equal(decks.length, 1);
  assert.equal(decks[0]!.isDefault, true);
  assert.deepEqual(decks[0]!.cards, owned);

  // Another account cannot see the deck, start from it, or finish that battle.
  assert.equal((await game.getSnapshot(OTHER)).decks.length, 0);
  await assert.rejects(game.startBattle(OTHER, { deckId: decks[0]!.id, opponentId: 'rookie' }), /덱을 찾을 수 없습니다/);

  const setup = await game.startBattle(USER, { deckId: decks[0]!.id, opponentId: 'rookie' }, DAY);
  assert.equal(setup.kind, 'pve');
  assert.equal(setup.ruleset, BATTLE_RULESET_VERSION);
  assert.equal(setup.player.length, 3);
  assert.equal(setup.opponent.length, 3);
  assert.ok(Number.isInteger(setup.seed) && setup.seed >= 0);
  assert.deepEqual(setup.player.map((entry) => entry.cardId), owned);

  await assert.rejects(game.finishBattle(OTHER, setup.battleId, []), /전투를 찾을 수 없습니다/);
  await assert.rejects(game.finishBattle(USER, setup.battleId, [{ uid: 'a0', action: 'win' }]), /올바르지/);
  await assert.rejects(game.finishBattle(USER, 'not-a-battle', []), /전투를 찾을 수 없습니다/);

  const played = play(USER, setup);
  const first = await game.finishBattle(USER, setup.battleId, played.decisions, DAY);
  const win = { battleId: setup.battleId, decisions: played.decisions, summary: first };
  assert.equal(win.summary.result, 'won', 'a common deck can beat the beginner opponent');
  assert.equal(win.summary.rewards.filter((line) => line.ticketType === 'low').reduce((sum, line) => sum + (line.quantity ?? 0), 0), 4, 'win and first clear each pay two low tickets');
  assert.equal(win.summary.mvpCardId !== null && owned.includes(win.summary.mvpCardId), true, 'MVP is one of the deployed cards');
  assert.ok(win.summary.damageDealt > 0);
  assert.ok(win.summary.rounds > 0);
  assert.equal(await creditsOf(USER), sumRewards(win.summary));

  // Repeating the finish returns the identical settled answer and pays nothing again.
  const again = await game.finishBattle(USER, win.battleId, win.decisions, DAY);
  assert.deepEqual(again, win.summary, 'the settled answer is stable across repeat calls');
  assert.equal(await creditsOf(USER), sumRewards(win.summary));

  // A repeat win against the same opponent pays no first-clear reward.
  const second = await game.startBattle(USER, { deckId: decks[0]!.id, opponentId: 'rookie' }, DAY);
  const repeat = await game.finishBattle(USER, second.battleId, play(USER, second).decisions, DAY);
  assert.equal(repeat.rewards.filter((line) => line.ticketType === 'low').reduce((sum, line) => sum + (line.quantity ?? 0), 0), 2);
  assert.equal(await creditsOf(USER), sumRewards(win.summary) + sumRewards(repeat));
});

test('concurrent finishes pay exactly once and achievements unlock once', async () => {
  reset();
  const owned = cardIdsByRarity({ N: 3 });
  seedOwned(db, USER, owned);
  const [deck] = await game.createDeck(USER, '동시성 덱', owned);
  const setup = await game.startBattle(USER, { deckId: deck!.id, opponentId: 'rookie' }, DAY);
  const played = play(USER, setup);

  const [left, right] = await Promise.all([
    game.finishBattle(USER, setup.battleId, played.decisions, DAY),
    game.finishBattle(USER, setup.battleId, played.decisions, DAY)
  ]);
  assert.deepEqual(left, right, 'both concurrent callers see one settled answer');
  assert.equal(left.result, played.result);
  assert.equal(await creditsOf(USER), sumRewards(left), 'the payout is not doubled');
  const claims = db.prepare("SELECT COUNT(*) AS c FROM reward_claims WHERE claim_key NOT LIKE 'settle:%'").get() as { c: number };
  assert.equal(Number(claims.c), left.rewards.length, 'one claim row per paid line');
  const unlockedRows = db.prepare('SELECT COUNT(*) AS c FROM user_achievements').get() as { c: number };
  assert.equal(Number(unlockedRows.c), left.unlocked.length);

  // A later battle never re-pays an achievement that is already unlocked. (The first battle may
  // legitimately be a loss, in which case the second one is the one that unlocks them.)
  const alreadyUnlocked = new Set(left.unlocked);
  const next = await game.startBattle(USER, { deckId: deck!.id, opponentId: 'rookie' }, DAY);
  const after = await game.finishBattle(USER, next.battleId, play(USER, next).decisions, DAY);
  assert.equal(after.unlocked.every((id) => !alreadyUnlocked.has(id)), true, 'no achievement is paid twice');
  const rowsAfter = db.prepare('SELECT COUNT(*) AS c FROM user_achievements').get() as { c: number };
  assert.equal(Number(rowsAfter.c), alreadyUnlocked.size + after.unlocked.length, 'one row per unlocked achievement');
});

test('daily challenge: same day for everyone, one payout a day, rule enforced', async () => {
  reset();
  seedOwned(db, USER, cardIdsByRarity({ N: 4, R: 4, SR: 2, SSR: 1, UR: 1 }));
  const owned = cardIdsByRarity({ N: 3 });
  db.exec(`UPDATE inventory SET enhance_level = 15 WHERE user_id = '${USER}'`);
  const [deck] = await game.createDeck(USER, '데일리 덱', owned);

  // Deterministic per KST date and identical for every user.
  const sameDay = dailyChallenge('2026-09-10');
  assert.deepEqual(dailyChallenge('2026-09-10'), sameDay);
  assert.notDeepEqual(dailyChallenge('2026-09-11').opponentId, sameDay.opponentId);

  // Find a day whose opponent is the beginner, so an N deck can actually win the daily.
  let day = new Date('2026-09-10T03:00:00Z');
  let challenge = dailyChallenge(kstDate(day));
  for (let step = 0; step < 40 && !(challenge.opponentId === 'rookie' && challenge.modifier.kind !== 'turn_limit'); step++) {
    day = new Date(day.getTime() + 86_400_000);
    challenge = dailyChallenge(kstDate(day));
  }
  assert.equal(challenge.opponentId, 'rookie', 'the rotation reaches the beginner opponent within six weeks');

  const setup = await game.startBattle(USER, { deckId: deck!.id, kind: 'daily' }, day);
  assert.equal(setup.opponentId, challenge.opponentId);
  assert.deepEqual(setup.modifier, challenge.modifier);
  const played = play(USER, setup);
  const firstTry = await game.finishBattle(USER, setup.battleId, played.decisions, day);
  const win = { battleId: setup.battleId, decisions: played.decisions, summary: firstTry };
  const summary = win.summary;
  assert.equal(summary.result, 'won');
  assert.ok(summary.rewards.some((line) => line.label === '데일리 챌린지 보상'), 'daily pays once');
  const paid = await creditsOf(USER);
  assert.deepEqual(await game.finishBattle(USER, win.battleId, win.decisions, day), summary);
  assert.equal(await creditsOf(USER), paid);

  // A second battle on the same KST day cannot claim the daily reward again.
  const repeat = await game.startBattle(USER, { deckId: deck!.id, kind: 'daily' }, day);
  const repeatSummary = await game.finishBattle(USER, repeat.battleId, play(USER, repeat).decisions, day);
  assert.equal(repeatSummary.rewards.filter((line) => line.label === '데일리 챌린지 보상').length, 0);

  // The KST boundary decides which challenge applies: 14:59Z and 15:00Z are different days.
  const before = new Date('2026-09-10T14:59:59Z');
  const after = new Date('2026-09-10T15:00:00Z');
  assert.equal(kstDate(before), '2026-09-10');
  assert.equal(kstDate(after), '2026-09-11');
  assert.notDeepEqual(dailyChallenge(kstDate(before)).id, dailyChallenge(kstDate(after)).id);
  const nextDay = await game.startBattle(USER, { deckId: deck!.id, kind: 'daily' }, after);
  assert.equal(nextDay.kind, 'daily');

  // A rarity-cap day refuses a deck of cards above the cap.
  const capped = await findDay((value) => value.modifier.kind === 'rarity_cap');
  const high = cardIdsByRarity({ UR: 1, SSR: 1, SR: 1 });
  seedOwned(db, USER, high);
  // createDeck returns every deck, so pick the new one by name instead of by position.
  const highDeck = (await game.createDeck(USER, '고등급 덱', high)).find((entry) => entry.name === '고등급 덱')!;
  await assert.rejects(
    game.startBattle(USER, { deckId: highDeck.id, kind: 'daily' }, capped.date),
    (error: unknown) => error instanceof game.GameError && error.code === 'invalid_deck'
  );
  assert.equal(capped.challenge.modifier.kind, 'rarity_cap');
});

test('a normal pull rolls the flat table and a failed pull rolls its charge back', async () => {
  reset();
  await db.prepare('UPDATE user_game_state SET pull_credits = 200 WHERE user_id = ?').bind(USER).run();
  const one = await game.pullCards(USER, 1);
  assert.ok(['N', 'R', 'SR', 'SSR', 'UR'].includes(one.results[0]!.card.rarity));
  assert.equal('pityRemaining' in one.snapshot, false, 'the snapshot no longer carries a pity ladder');

  const five = await game.pullCards(USER, 5);
  assert.equal(five.results.length, 5);

  const creditsBefore = await creditsOf(USER);
  db.exec("CREATE TRIGGER fail_pull BEFORE INSERT ON pull_history BEGIN SELECT RAISE(ABORT, 'simulated outage'); END");
  await assert.rejects(game.pullCards(USER, 1));
  db.exec('DROP TRIGGER fail_pull');
  assert.equal(await creditsOf(USER), creditsBefore, 'a failed pull restores credits');
});

test('existing collection behaviour is unchanged: free pull, coupon, starter deck', async () => {
  reset();
  const first = await game.pullCards(USER, 1);
  assert.equal(first.results[0]!.usedFreePull, true);
  assert.equal(await creditsOf(USER), 0);
  const snapshot = await game.getSnapshot(USER);
  assert.equal(snapshot.inventory.length, 1);
  assert.equal(snapshot.decks.length, 0, 'one card is not enough for a deck');
  assert.equal(snapshot.opponents.length, OPPONENTS.length);
  assert.equal(snapshot.daily.cleared, false);

  const coupon = await game.redeemCoupon(USER, 'limketmon');
  assert.equal(coupon.snapshot.credits, 10, 'LIMKETMON grants ten normal pulls');
  assert.equal(coupon.snapshot.tickets.ssr, 1, 'and a single SSR+ ticket');
  assert.equal(coupon.snapshot.tickets.low, 50, 'and fifty low tickets');
  await assert.rejects(game.redeemCoupon(USER, 'LIMKETMON'), /이미 사용한 쿠폰/);
  await assert.rejects(game.redeemCoupon(USER, 'NOPE'), /유효하지 않은/);

  const five = await game.pullCards(USER, 5);
  assert.equal(five.results.length, 5);
  assert.equal(five.results.every((result) => !result.usedFreePull), true);
  assert.equal(await creditsOf(USER), 5);

  // The starter deck appears as soon as three cards are owned, and is legally buildable.
  let owns = (await game.getSnapshot(USER)).inventory.length;
  while (owns < 3) {
    const more = await game.pullCards(USER, 1);
    if (!more.results.length) break;
    owns = more.snapshot.inventory.length;
  }
  const withDeck = await game.getSnapshot(USER);
  assert.ok(withDeck.decks.length >= 1, 'a starter deck is created once three cards are owned');
  assert.equal(withDeck.decks[0]!.cards.length, 3);
});

test('replay reproduces the stored battle; an older ruleset is refused, not re-judged', async () => {
  reset();
  const owned = cardIdsByRarity({ N: 3 });
  seedOwned(db, USER, owned);
  const [deck] = await game.createDeck(USER, '리플레이 덱', owned);
  const setup = await game.startBattle(USER, { deckId: deck!.id, opponentId: 'regular' }, DAY);
  const summary = await game.finishBattle(USER, setup.battleId, play(USER, setup).decisions, DAY);

  const replay = await game.replayBattle(USER, setup.battleId);
  assert.equal(replay.rulesetVersion, BATTLE_RULESET_VERSION);
  assert.equal(replay.result, summary.result);
  assert.equal(replay.verified, true, 'stored decisions re-simulate to the stored result');
  assert.equal(replay.setup.seed, setup.seed);
  assert.ok(replay.events.length > 0);
  await assert.rejects(game.replayBattle(OTHER, setup.battleId), /전투를 찾을 수 없습니다/);

  const stale = await game.startBattle(USER, { deckId: deck!.id, opponentId: 'rookie' }, DAY);
  db.prepare('UPDATE battles SET ruleset_version = 999 WHERE id = ?').bind(stale.battleId).run();
  const refused = await game.finishBattle(USER, stale.battleId, [{ uid: 'a0', action: 'attack' }], DAY);
  assert.deepEqual(refused, { result: 'invalid', rewards: [], unlocked: [], mvpCardId: null, rounds: 0, damageDealt: 0 });
  await assert.rejects(game.replayBattle(USER, stale.battleId), /이전 규칙/);
  assert.equal((await game.getSnapshot(USER)).stats.battles >= 1, true);
});

test('a chosen unlocked skill round-trips through start, finish, replay and the cached answer', async () => {
  reset();
  const owned = cardIdsByRarity({ N: 3 });
  seedOwned(db, USER, owned);
  // +5 duplicate enhancement unlocks exactly one additional skill per card.
  for (const id of owned) {
    db.exec(`UPDATE inventory SET enhance_level = 5 WHERE user_id = '${USER}' AND card_id = '${id}'`);
  }
  const deck = (await game.createDeck(USER, '스킬 덱', owned)).find((entry) => entry.name === '스킬 덱')!;
  const setup = await game.startBattle(USER, { deckId: deck.id, opponentId: 'rookie' }, DAY);
  const skills = setup.player.flatMap((entry) => entry.skills ?? []);
  assert.equal(skills.length, 3, 'each +5 card ships its unlocked skill to the client');
  const unlockedId = skills[0]!.id;
  assert.match(unlockedId, /^skill:[^:]+:5$/);

  // Malformed, foreign and not-yet-unlocked ids are all refused without settling the battle, so a
  // tampered log never freezes the row.
  await assert.rejects(game.finishBattle(USER, setup.battleId, [{ uid: 'a0', action: 'skill', skillId: 42 }]), /올바르지/);
  assert.equal((await game.finishBattle(USER, setup.battleId, [{ uid: 'a0', action: 'skill', skillId: 'skill:not-a-card:5' }], DAY)).result, 'invalid');
  assert.equal((await game.finishBattle(USER, setup.battleId, [{ uid: 'a0', action: 'skill', skillId: `skill:${owned[0]}:15` }], DAY)).result, 'invalid');
  assert.equal((await game.finishBattle(USER, setup.battleId, [{ uid: 'a0', action: 'attack', skillId: unlockedId }], DAY)).result, 'invalid');
  const pending = (await db.prepare('SELECT result FROM battles WHERE id = ?').bind(setup.battleId).first()) as { result: string };
  assert.equal(pending.result, 'pending', 'the rejected attempts leave the battle open');

  const played = playWithSkills(setup);
  assert.equal(played.usedSkill, true, 'the decided log actually fires an unlocked skill');
  const settled = await game.finishBattle(USER, setup.battleId, played.decisions, DAY);
  assert.notEqual(settled.result, 'invalid', 'the chosen-skill log replays as a legal battle');
  const stored = (await db.prepare('SELECT decisions, result FROM battles WHERE id = ?').bind(setup.battleId).first()) as { decisions: string; result: string };
  assert.equal(stored.result, settled.result);
  assert.equal(
    (JSON.parse(stored.decisions) as Array<{ skillId?: string }>).some((decision) => decision.skillId === unlockedId),
    true,
    'the replay persists the chosen skill id'
  );
  const replay = await game.replayBattle(USER, setup.battleId);
  assert.equal(replay.verified, true, 'the stored skill log re-simulates to the stored result');
  assert.equal(replay.result, settled.result);

  // The cached repeat call returns the identical settled summary and pays nothing again.
  const credits = await creditsOf(USER);
  assert.deepEqual(await game.finishBattle(USER, setup.battleId, played.decisions, DAY), settled);
  assert.equal(await creditsOf(USER), credits);
});

function sumRewards(summary: { rewards: Array<{ credits: number }> }): number {
  return summary.rewards.reduce((sum, line) => sum + line.credits, 0);
}

async function creditsOf(userId: string): Promise<number> {
  const row = (await db.prepare('SELECT pull_credits FROM user_game_state WHERE user_id = ?').bind(userId).first()) as { pull_credits: number };
  return Number(row.pull_credits);
}

/**
 * Plays until the player wins, capped at a handful of attempts. The server owns the seed, so
 * "this deck can beat this opponent" is a property of the deck, not of one roll.
 */
/**
 * Plays a started battle deterministically, preferring skills and falling back to attacks.
 * Drives createBattle/advance directly, so a battle costs one pass rather than a replay per turn.
 */
function play(_userId: string, setup: Awaited<ReturnType<typeof game.startBattle>>) {
  const full = {
    battleId: setup.battleId,
    kind: setup.kind,
    mode: setup.mode,
    opponentId: setup.opponentId,
    modifier: setup.modifier,
    seed: setup.seed,
    player: setup.player,
    opponent: setup.opponent
  };
  const profile = opponentById(setup.opponentId, setup.mode ?? 'normal')!.profile;
  let state = createBattle(full);
  const decisions: Array<{ uid: string; action: 'attack' | 'skill' }> = [];
  for (let step = 0; step < 500 && state.status === 'active'; step++) {
    const uid = state.activeUid;
    if (!uid) break;
    const isPlayer = uid.startsWith('a');
    let action: 'attack' | 'skill' = isPlayer ? 'skill' : aiDecision(state, profile).action;
    let result = advance(state, { uid, action });
    if (result.error) {
      if (!isPlayer) throw new Error(`unexpected opponent error: ${result.error}`);
      action = 'attack';
      result = advance(state, { uid, action });
    }
    if (result.error) throw new Error(`unexpected engine error: ${result.error}`);
    state = result.state;
    if (isPlayer) decisions.push({ uid, action });
  }
  return { decisions, result: state.status };
}

/**
 * Like play(), but the player fires its first unlocked skill whenever it is legal and falls back
 * to a plain attack otherwise, so the server sees an explicit skill id in the decision log.
 */
function playWithSkills(setup: Awaited<ReturnType<typeof game.startBattle>>) {
  const full = {
    battleId: setup.battleId,
    kind: setup.kind,
    mode: setup.mode,
    opponentId: setup.opponentId,
    modifier: setup.modifier,
    seed: setup.seed,
    player: setup.player,
    opponent: setup.opponent
  };
  const profile = opponentById(setup.opponentId, setup.mode ?? 'normal')!.profile;
  let state = createBattle(full);
  const decisions: Array<{ uid: string; action: 'attack' | 'skill'; skillId?: string }> = [];
  let usedSkill = false;
  for (let step = 0; step < 500 && state.status === 'active'; step++) {
    const uid = state.activeUid;
    if (!uid) break;
    if (uid.startsWith('a')) {
      const actor = [...state.sides.a, ...state.sides.b].find((entry) => entry.uid === uid)!;
      const skillId = (actor.skills ?? [])[0]?.id;
      let decision: { uid: string; action: 'attack' | 'skill'; skillId?: string } = skillId
        ? { uid, action: 'skill', skillId }
        : { uid, action: 'attack' };
      let result = advance(state, decision);
      if (result.error) {
        decision = { uid, action: 'attack' };
        result = advance(state, decision);
      }
      if (result.error) throw new Error(`unexpected engine error: ${result.error}`);
      state = result.state;
      decisions.push(decision);
      if (decision.skillId) usedSkill = true;
    } else {
      const action = aiDecision(state, profile).action;
      const result = advance(state, { uid, action });
      if (result.error) throw new Error(`unexpected opponent error: ${result.error}`);
      state = result.state;
    }
  }
  return { decisions, usedSkill, result: state.status };
}

async function findDay(predicate: (challenge: ReturnType<typeof dailyChallenge>) => boolean) {
  let date = new Date('2026-09-10T03:00:00Z');
  for (let step = 0; step < 40; step++) {
    const challenge = dailyChallenge(kstDate(date));
    if (predicate(challenge)) return { date, challenge };
    date = new Date(date.getTime() + 86_400_000);
  }
  throw new Error('no matching daily challenge found in 40 days');
}
