import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test, { after } from 'node:test';
import { createD1, migrate } from './helpers/d1.mjs';
import { env } from './helpers/cloudflare-workers.mjs';
import { setAuthenticatedUser } from './helpers/next-headers.mjs';
import { parseTraits, traitCost, type Trait } from '../lib/progression.ts';

const db = createD1();
const dir = new URL('../drizzle/', import.meta.url);
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) migrate(db, readFileSync(new URL(file, dir), 'utf8'));
env.DB = db;
const game = await import('../lib/game.ts');
const { applyProgression } = await import('../lib/progression-server.ts');
const route = await import('../app/api/progression/route.ts');
after(() => db.close());
const base = game.cards.find((card) => card.rarity === 'N')!;
const trait = (spentProof?: number): Trait => ({ id: 'damage', level: 10, transcended: false, ...(spentProof === undefined ? {} : { spentProof }) });
let sequence = 0;
async function setup(traits: Trait[], quantity = 1, rarity: string | null = null) {
  const u = `refund-${++sequence}`;
  await game.ensureUser(u, `${u}@local.invalid`);
  db.prepare("INSERT INTO decks VALUES (?, ?, 'test', 1, 'now', 'now')").bind(u, u).run();
  db.prepare("INSERT INTO inventory (user_id,card_id,quantity,first_obtained_at,enhance_level,traits,rarity_override) VALUES (?,?,?,'now',5,?,?)").bind(u, base.id, quantity, JSON.stringify(traits), rarity).run();
  db.prepare('UPDATE user_game_state SET proof=10000,fragments=7,twin_proof=5 WHERE user_id=?').bind(u).run();
  return u;
}
const row = (u: string, cardId = base.id) => db.prepare('SELECT * FROM inventory WHERE user_id=? AND card_id=?').bind(u, cardId).first();
const state = (u: string) => db.prepare('SELECT * FROM user_game_state WHERE user_id=?').bind(u).first();
const traitsOf = (u: string, cardId = base.id) => parseTraits(row(u, cardId).traits);
const request = (u: string, action: string, extra = {}, cardId = base.id) => applyProgression(u, { action, cardId, traitId: 'damage', ...extra });
async function preview(u: string, cardId = base.id) {
  const result = await request(u, 'remove-trait', { preview: true }, cardId);
  assert.ok('preview' in result && 'expectedTraits' in result.preview);
  return result.preview;
}
async function remove(u: string, cardId = base.id) {
  const p = await preview(u, cardId);
  return request(u, 'remove-trait', { expectedTraits: p.expectedTraits }, cardId);
}

test('parser preserves zero and safe metadata without changing old snapshots', () => {
  for (const value of [0, 13, Number.MAX_SAFE_INTEGER]) assert.deepEqual(parseTraits([{ ...trait(value), refundEstimated: true }]), [{ ...trait(value), refundEstimated: true }]);
  for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '9', null]) assert.equal(parseTraits([{ ...trait(), spentProof: value }])[0].spentProof, undefined);
  assert.deepEqual(parseTraits(JSON.stringify([trait()])), [trait()]);
});

test('API preview is read-only; removal floors refund, frees slot and preserves other growth', async () => {
  for (const transcended of [false, true]) {
    const other: Trait = { id: 'synergy', level: 7, transcended: false, spentProof: 42 };
    const u = await setup([{ ...trait(13), transcended }, other], 3, 'R');
    const before = { ...row(u) }, balance = { ...state(u) };
    setAuthenticatedUser(u);
    const post = (body: unknown) => route.POST(new Request('http://local/api/progression', { method: 'POST', body: JSON.stringify(body) }));
    const response = await post({ action: 'remove-trait', cardId: base.id, traitId: 'damage', preview: true });
    assert.equal(response.status, 200);
    const { preview: p } = await response.json();
    assert.deepEqual(p.cards, []); assert.equal(p.proof, 6); assert.equal(p.minFragments, 0); assert.equal(p.expectedTraits, before.traits);
    assert.deepEqual({ ...row(u) }, before); assert.deepEqual({ ...state(u) }, balance);
    assert.equal((await post({ action: 'remove-trait', cardId: base.id, traitId: 'damage', expectedTraits: p.expectedTraits })).status, 200);
    assert.deepEqual({ ...row(u) }, { ...before, traits: JSON.stringify([other]) });
    assert.deepEqual({ ...state(u) }, { ...balance, proof: balance.proof + 6 });
    await request(u, 'trait', { traitId: 'resist_fire' });
    assert.equal(traitsOf(u).length, 2);
  }
});

test('zero refund succeeds; malformed, missing and replayed tokens never credit', async () => {
  const u = await setup([trait(0)]), stranger = await setup([]);
  const balance = { ...state(u) }, raw = row(u).traits;
  for (const expectedTraits of [undefined, null, {}, [], 0, '', '[broken', '[]']) await assert.rejects(request(u, 'remove-trait', { expectedTraits }));
  await assert.rejects(request(stranger, 'remove-trait', { expectedTraits: raw }));
  assert.deepEqual({ ...state(u) }, balance);
  await remove(u);
  assert.deepEqual(traitsOf(u), []); assert.deepEqual({ ...state(u) }, balance);
  await assert.rejects(request(u, 'remove-trait', { expectedTraits: raw }));
});

test('concurrent removal and training cannot double credit or lose sibling traits', async () => {
  const u = await setup([trait(101)]), p = await preview(u);
  const results = await Promise.allSettled([request(u, 'remove-trait', { expectedTraits: p.expectedTraits }), request(u, 'remove-trait', { expectedTraits: p.expectedTraits })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(state(u).proof, 10050);
  await assert.rejects(request(u, 'remove-trait', { expectedTraits: p.expectedTraits }));
  const v = await setup([trait(101)]), old = await preview(v);
  await request(v, 'trait', { traitId: 'synergy' });
  const balance = state(v).proof;
  await assert.rejects(request(v, 'remove-trait', { expectedTraits: old.expectedTraits }));
  assert.equal(state(v).proof, balance); assert.equal(traitsOf(v).length, 2);
  const fresh = await preview(v);
  const race = await Promise.allSettled([request(v, 'trait'), request(v, 'remove-trait', { expectedTraits: fresh.expectedTraits })]);
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(traitsOf(v).find((t) => t.id === 'synergy')!.level, 1);
  assert.equal(state(v).proof, traitsOf(v).some((t) => t.id === 'damage') ? balance - traitCost('N', 10) : balance + 50);
});

test('failed credit rolls deletion back in SQLite', async () => {
  const u = await setup([trait(13)]), before = row(u).traits;
  db.exec("CREATE TRIGGER refund_failure BEFORE UPDATE OF proof ON user_game_state WHEN NEW.proof > OLD.proof BEGIN SELECT RAISE(ABORT, 'refund_test_failure'); END");
  try { await assert.rejects(remove(u), /refund_test_failure/); }
  finally { db.exec('DROP TRIGGER refund_failure'); }
  assert.equal(row(u).traits, before); assert.equal(state(u).proof, 10000);
});

test('legacy spending uses original grade, marking promoted history as estimated', async () => {
  const paid = Array.from({ length: 10 }, (_, i) => traitCost('N', i)).reduce((a, b) => a + b, 0);
  for (const rarity of [null, 'SSR'] as const) {
    const u = await setup([trait()], 1, rarity), p = await preview(u);
    assert.equal(p.proof, Math.floor(paid / 2));
    assert.equal(p.warning.includes('원본 등급 기준 추정액'), rarity !== null);
    assert.equal(traitsOf(u)[0].spentProof, undefined);
    await request(u, 'trait');
    assert.equal(traitsOf(u)[0].spentProof, paid + traitCost(rarity ?? 'N', 10));
    assert.equal(traitsOf(u)[0].refundEstimated === true, rarity !== null);
    const balance = state(u).proof;
    await remove(u);
    assert.equal(state(u).proof, balance + Math.floor((paid + traitCost(rarity ?? 'N', 10)) / 2));
  }
});

test('fresh costs follow actual grade; singleton transcend transfers budget and deck', async () => {
  const u = await setup([]);
  for (let i = 0; i < 10; i++) await request(u, 'trait');
  const paid = 10000 - state(u).proof;
  assert.equal(traitsOf(u)[0].spentProof, paid);
  db.prepare('INSERT INTO deck_cards VALUES (?,0,?)').bind(u, base.id).run();
  const result = await request(u, 'transcend');
  assert.ok('cardId' in result && result.cardId);
  assert.equal(row(u), null);
  assert.equal(db.prepare('SELECT card_id FROM deck_cards WHERE deck_id=?').bind(u).first().card_id, result.cardId);
  assert.equal(traitsOf(u, result.cardId)[0].spentProof, paid);
  await request(u, 'trait', {}, result.cardId);
  assert.equal(traitsOf(u, result.cardId)[0].spentProof, paid + traitCost('R', 10));
  const before = state(u).proof;
  await remove(u, result.cardId);
  assert.equal(state(u).proof, before + Math.floor((paid + traitCost('R', 10)) / 2));
});

test('stack transcend initializes source history once and never clones either budget', async () => {
  const other: Trait = { id: 'synergy', level: 7, transcended: false };
  const u = await setup([trait(), other], 3);
  const sourcePaid = Array.from({ length: 10 }, (_, i) => traitCost('N', i)).reduce((a, b) => a + b, 0);
  for (let i = 0; i < 2; i++) {
    const result = await request(u, 'transcend');
    assert.ok('cardId' in result && result.cardId);
    assert.equal(traitsOf(u)[0].transcended, false); assert.equal(traitsOf(u)[0].spentProof, sourcePaid);
    assert.ok(traitsOf(u)[1].spentProof! > 0);
    assert.deepEqual(traitsOf(u, result.cardId).map((t) => t.spentProof), [0, 0]);
    assert.equal((await preview(u, result.cardId)).proof, 0);
    await request(u, 'trait', {}, result.cardId);
    assert.equal(traitsOf(u, result.cardId)[0].spentProof, traitCost('R', 10));
    const balance = state(u).proof;
    await remove(u, result.cardId);
    assert.equal(state(u).proof, balance + Math.floor(traitCost('R', 10) / 2));
  }
  assert.equal(row(u).quantity, 1);
  const balance = state(u).proof;
  await remove(u);
  assert.equal(state(u).proof, balance + Math.floor(sourcePaid / 2));
});


test('legacy singleton promotion carries original-grade history without inventing an estimate', async () => {
  const u = await setup([trait()]);
  const p = await preview(u);
  const result = await request(u, 'transcend');
  assert.ok('cardId' in result && result.cardId);
  const promoted = await preview(u, result.cardId);
  assert.equal(promoted.proof, p.proof);
  assert.equal(promoted.warning.includes('추정액'), false);
  assert.equal(traitsOf(u, result.cardId)[0].spentProof, 80);
  const balance = state(u).proof;
  await remove(u, result.cardId);
  assert.equal(state(u).proof, balance + 40);
});
