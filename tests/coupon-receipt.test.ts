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
