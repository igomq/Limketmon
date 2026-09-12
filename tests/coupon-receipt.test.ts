// The private ticket coupon reports its committed increments and never changes cards.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test, { after } from 'node:test';
import { createD1, migrate } from './helpers/d1.mjs';
import { env } from './helpers/cloudflare-workers.mjs';

const migrationDir = new URL('../drizzle/', import.meta.url);
const db = createD1();
for (const file of readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()) {
  migrate(db, readFileSync(new URL(file, migrationDir), 'utf8'));
}
env.DB = db;

const game = await import('../lib/game.ts');
after(() => db.close());

const USER = 'receipt_user';
/** Fixture secret: the real code is a deploy-time value and never appears in source or tests. */
const CODE = 'TEST-ONLY-CARD-GRANT';
const ownedRow = (cardId: string) => db.prepare('SELECT * FROM inventory WHERE user_id = ? AND card_id = ?').bind(USER, cardId).first();
const redemptionCount = () => db.prepare('SELECT COUNT(*) AS c FROM coupon_redemptions WHERE user_id = ?').bind(USER).first().c;

test('private test coupon repeats, grants all four tickets, and leaves inventory untouched', async () => {
  await game.ensureUser(USER, 'receipt@local.invalid');
  const base = game.cards[0]!;
  const traits = [{ id: 'damage', level: 10, transcended: false }];
  db.prepare("INSERT INTO inventory (user_id,card_id,quantity,first_obtained_at,enhance_level,traits,base_card_id,rarity_override) VALUES (?,?,?,'now',?,?,?,?)")
    .bind(USER, 'receipt-variant', 7, 9, JSON.stringify(traits), base.id, base.rarity).run();
  const before = ownedRow('receipt-variant');
  await assert.rejects(game.redeemCoupon(USER, CODE), /유효하지 않은/);
  assert.equal(redemptionCount(), 0);
  env.PRIVATE_CARD_COUPON = `  ${CODE.toLowerCase()}  `;
  try {
    for (const round of [1, 2]) {
      const receipt = await game.redeemCoupon(USER, round === 1 ? CODE : ` ${CODE.toLowerCase()} `);
      assert.deepEqual(receipt.granted, { credits: 100, low: 100, sr: 100, ssr: 100 });
      assert.equal(receipt.snapshot.credits, round * 100);
      assert.deepEqual(receipt.snapshot.tickets, { low: round * 100, sr: round * 100, ssr: round * 100 });
      assert.equal(receipt.snapshot.inventory.length, 1);
      assert.deepEqual(ownedRow('receipt-variant'), before);
      assert.ok(!JSON.stringify(receipt).includes(CODE.toLowerCase()));
    }
  } finally { delete env.PRIVATE_CARD_COUPON; }
  assert.equal(redemptionCount(), 0);
});


test('private each-card coupon grants 200 per catalog card, repeats, preserves growth and rolls back', async () => {
  const u = 'each-card-user';
  await game.ensureUser(u, 'each@local.invalid');
  const first = game.cards[0]!;
  db.prepare("INSERT INTO inventory (user_id,card_id,quantity,first_obtained_at,enhance_level,traits) VALUES (?,?,7,'before',5,?)")
    .bind(u, first.id, JSON.stringify([{ id: 'damage', level: 10, transcended: true }])).run();
  const before = db.prepare('SELECT * FROM inventory WHERE user_id=?').bind(u).first();
  const code = 'FIXTURE-EACH-CARD';
  await assert.rejects(game.redeemCoupon(u, code), /유효하지/);
  env.PRIVATE_EACH_CARD_COUPON = code;
  try {
    const receipts = await Promise.all([game.redeemCoupon(u, code.toLowerCase()), game.redeemCoupon(u, ` ${code} `)]);
    for (const r of receipts) assert.deepEqual(r.granted, { credits: 0, low: 0, sr: 0, ssr: 0, cards: game.cards.length * 200, cardTypes: game.cards.length, copiesPerCard: 200 });
    const rows = db.prepare('SELECT * FROM inventory WHERE user_id=?').bind(u).all().results;
    assert.equal(rows.length, game.cards.length);
    for (const row of rows) assert.equal(row.quantity, row.card_id === first.id ? 407 : 400);
    const grown = rows.find((row) => row.card_id === first.id);
    assert.deepEqual({ ...grown, quantity: before.quantity }, { ...before });
    assert.equal((await game.getSnapshot(u)).credits, 0);
    db.exec(`CREATE TRIGGER fail_each BEFORE UPDATE ON inventory WHEN NEW.card_id = '${game.cards[1]!.id}' BEGIN SELECT RAISE(ABORT,'fixture failure'); END`);
    await assert.rejects(game.redeemCoupon(u, code), /fixture failure/);
    assert.deepEqual(db.prepare('SELECT * FROM inventory WHERE user_id=?').bind(u).all().results, rows);
    db.exec('DROP TRIGGER fail_each');
  } finally { delete env.PRIVATE_EACH_CARD_COUPON; }
});
