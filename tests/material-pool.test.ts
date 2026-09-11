import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test, { after } from 'node:test';
import { createD1, migrate } from './helpers/d1.mjs';
import { env } from './helpers/cloudflare-workers.mjs';
import { enhanceCost } from '../lib/enhance.ts';
import { savePull } from '../lib/pull.ts';

const db = createD1();
const dir = new URL('../drizzle/', import.meta.url);
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) migrate(db, readFileSync(new URL(file, dir), 'utf8'));
env.DB = db;
const game = await import('../lib/game.ts');
const { applyProgression } = await import('../lib/progression-server.ts');
after(() => db.close());
const base = game.cards.find((c) => c.rarity === 'N')!.id;
async function user() {
  const u = crypto.randomUUID();
  await game.ensureUser(u, `${u}@local.invalid`);
  db.prepare("INSERT INTO decks VALUES (?, ?, 'test', 1, 'now', 'now')").bind(u, u).run();
  return u;
}
function own(u: string, id: string, quantity: number, level = 0, rarity = 'N', baseId = base) {
  db.prepare("INSERT INTO inventory (user_id,card_id,quantity,first_obtained_at,enhance_level,base_card_id,rarity_override) VALUES (?,?,?,'now',?,?,?)")
    .bind(u, id, quantity, level, id === baseId ? null : baseId, id === baseId ? null : rarity).run();
}
const row = (u: string, id: string) => db.prepare('SELECT * FROM inventory WHERE user_id=? AND card_id=?').bind(u, id).first();
const dump = (u: string) => JSON.stringify(db.prepare('SELECT * FROM inventory WHERE user_id=? ORDER BY card_id').bind(u).all().results);
const shortage = (e: unknown) => e instanceof game.GameError && e.code === 'not_enough_copies';

// Exercises the actual fusion/transcend and enhancement entry points over migrated SQLite.
test('fresh fusion and transcend singletons enhance from original duplicates at exact cost', async () => {
  for (const action of ['fuse', 'transcend']) {
    const u = await user();
    let output: string;
    if (action === 'fuse') {
      for (const c of game.cards.filter((c) => c.rarity === 'N')) own(u, c.id, 8, 0, 'N', c.id);
      output = (await applyProgression(u, { action, count: 2, cards: [{ cardId: base, quantity: 2 }] })).cardId!;
    } else {
      own(u, base, 8, 5);
      db.prepare('UPDATE inventory SET traits=? WHERE user_id=?').bind(JSON.stringify([{ id: 'damage', level: 10, transcended: false }]), u).run();
      db.prepare('UPDATE user_game_state SET twin_proof=1 WHERE user_id=?').bind(u).run();
      output = (await applyProgression(u, { action, cardId: base, traitId: 'damage' })).cardId!;
    }
    const before = row(u, output), source = row(u, before.base_card_id);
    const snapshot = await game.enhanceCard(u, output);
    assert.equal(row(u, output).quantity, 1);
    assert.equal(row(u, output).enhance_level, before.enhance_level + 1);
    assert.equal(row(u, output).traits, before.traits);
    assert.equal(row(u, before.base_card_id).quantity, source.quantity - enhanceCost(before.enhance_level));
    const pool = snapshot.inventory.filter((r) => r.baseCardId === before.base_card_id);
    assert.ok(pool.every((r) => r.materialCount === source.quantity - enhanceCost(before.enhance_level) - 1));
  }
});

test('multirow pool crosses effective rarities, keeps all bodies and does not touch other bases/users', async () => {
  const u = await user(), other = await user();
  own(u, base, 3); own(u, 'variant', 1, 4, 'XR'); own(u, 'surplus', 4, 8, 'SSR');
  const unrelated = game.cards.find((c) => c.id !== base)!.id;
  own(u, unrelated, 20, 0, 'N', unrelated); own(other, base, 20);
  const snapshot = await game.enhanceCard(u, 'variant');
  for (const id of [base, 'variant', 'surplus']) {
    assert.equal(row(u, id).quantity, 1);
    assert.equal(snapshot.inventory.find((r) => r.cardId === id)!.materialCount, 0);
  }
  assert.equal(row(u, 'variant').enhance_level, 5); assert.equal(row(u, 'surplus').enhance_level, 8);
  assert.equal(row(u, unrelated).quantity, 20); assert.equal(row(other, base).quantity, 20);
  const before = dump(u);
  await assert.rejects(() => game.enhanceCard(u, 'variant'), shortage);
  assert.equal(dump(u), before);
});

test('competing enhancements of different variants cannot double consume shared duplicates', async () => {
  const u = await user(); own(u, base, 2); own(u, 'a', 1); own(u, 'b', 1);
  const results = await Promise.allSettled([game.enhanceCard(u, 'a'), game.enhanceCard(u, 'b')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(row(u, 'a').enhance_level + row(u, 'b').enhance_level, 1);
  for (const id of [base, 'a', 'b']) assert.equal(row(u, id).quantity, 1);
});

test('concurrent enhancement and dismantle cannot overconsume or pay twice', async () => {
  const u = await user(); own(u, base, 2); own(u, 'variant', 1);
  const results = await Promise.allSettled([
    game.enhanceCard(u, 'variant'),
    applyProgression(u, { action: 'dismantle', cards: [{ cardId: base, quantity: 1 }] })
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(row(u, base).quantity, 1); assert.equal(row(u, 'variant').quantity, 1);
  const proof = db.prepare('SELECT proof FROM user_game_state WHERE user_id=?').bind(u).first().proof;
  assert.equal(proof + row(u, 'variant').enhance_level, 1);
});

test('stale late donor rolls back earlier writes and retry preserves a new pull', async () => {
  for (const delta of [-1, 1]) {
    const u = await user(); own(u, 'a', 2); own(u, 'z', 2); own(u, 'variant', 1, 1);
    const batch = db.batch.bind(db); let injected = false;
    db.batch = async (statements) => {
      if (!injected && statements.some((s) => s.query.includes('enhance_level = enhance_level + 1'))) {
        injected = true;
        db.prepare('UPDATE inventory SET quantity=quantity+? WHERE user_id=? AND card_id=?').bind(delta, u, 'z').run();
      }
      return batch(statements);
    };
    try {
      if (delta < 0) await assert.rejects(() => game.enhanceCard(u, 'variant'), shortage);
      else await game.enhanceCard(u, 'variant');
    } finally { db.batch = batch; }
    assert.ok(injected);
    assert.equal(row(u, 'a').quantity, delta < 0 ? 2 : 1);
    assert.equal(row(u, 'z').quantity, delta < 0 ? 1 : 2);
    assert.equal(row(u, 'variant').enhance_level, delta < 0 ? 1 : 2);
  }
});

test('single row costs stay unchanged and max level refuses without consuming pool', async () => {
  const u = await user(); own(u, base, 121);
  for (let level = 0; level < 15; level++) {
    const before = row(u, base).quantity;
    await game.enhanceCard(u, base);
    assert.equal(row(u, base).quantity, before - enhanceCost(level));
  }
  assert.equal(row(u, base).quantity, 1);
  own(u, 'spare', 20);
  const before = dump(u);
  await assert.rejects(() => game.enhanceCard(u, base), (e: unknown) => e instanceof game.GameError && e.code === 'max_enhance');
  assert.equal(dump(u), before);
});


test('normal pull racing enhancement accrues to base stack and is not lost on CAS retry', async () => {
  const u = await user(); own(u, base, 2); own(u, 'variant', 1);
  const batch = db.batch.bind(db); let injected = false;
  db.batch = async (statements) => {
    if (!injected && statements.some((s) => s.query.includes('enhance_level = enhance_level + 1'))) {
      injected = true;
      const receipt = await savePull(db, u, [game.cards.find((c) => c.id === base)!], new Date(), 0, 0);
      assert.equal(receipt[0]!.quantity, 3); assert.equal(receipt[0]!.usedFreePull, true);
    }
    return batch(statements);
  };
  let snapshot;
  try { snapshot = await game.enhanceCard(u, 'variant'); } finally { db.batch = batch; }
  assert.ok(injected); assert.equal(row(u, base).quantity, 2); assert.equal(row(u, 'variant').quantity, 1);
  assert.equal(row(u, 'variant').enhance_level, 1);
  assert.ok(snapshot.inventory.every((r) => r.materialCount === 1));
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM pull_history WHERE user_id=?').bind(u).first().c, 1);
});

test('target consumed before the batch cannot consume donors or resurrect an owned card', async () => {
  const u = await user(); own(u, base, 3); own(u, 'variant', 1);
  const batch = db.batch.bind(db); let injected = false;
  db.batch = async (statements) => {
    if (!injected && statements.some((s) => s.query.includes('enhance_level = enhance_level + 1'))) {
      injected = true;
      await applyProgression(u, { action: 'dismantle', cards: [{ cardId: 'variant', quantity: 1 }] });
    }
    return batch(statements);
  };
  try {
    await assert.rejects(() => game.enhanceCard(u, 'variant'), (e: unknown) => e instanceof game.GameError && e.code === 'not_owned');
  } finally { db.batch = batch; }
  assert.ok(injected); assert.equal(row(u, 'variant'), null); assert.equal(row(u, base).quantity, 3);
  assert.equal(db.prepare('SELECT proof FROM user_game_state WHERE user_id=?').bind(u).first().proof, 1);
});
