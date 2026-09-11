// A coupon must report the grant it actually wrote. The private card coupon repeats, so its receipt
// has to come back from the rows the batch touched - and repeating it must not cost a variant row its
// enhancement, traits, identity or copies.
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
const COPIES = 100;
const ownedRow = (cardId: string) => db.prepare('SELECT * FROM inventory WHERE user_id = ? AND card_id = ?').bind(USER, cardId).first();
const redemptionCount = () => db.prepare('SELECT COUNT(*) AS c FROM coupon_redemptions WHERE user_id = ?').bind(USER).first().c;

test('private card coupon repeats, reports the grant it wrote, and preserves variants', async () => {
  await game.ensureUser(USER, 'receipt@local.invalid');
  db.prepare("INSERT INTO decks VALUES (?, ?, 'receipt', 1, 'now', 'now')").bind(USER, USER).run();
  const base = game.cards[0]!;
  const traits = [{ id: 'damage', level: 10, transcended: false }];
  db.prepare("INSERT INTO inventory (user_id,card_id,quantity,first_obtained_at,enhance_level,traits,base_card_id,rarity_override) VALUES (?,?,?,'now',?,?,?,?)")
    .bind(USER, 'receipt-variant', 7, 9, JSON.stringify(traits), base.id, base.rarity).run();

  // Without the secret the code is refused: no grant, no success receipt, no redemption row.
  await assert.rejects(game.redeemCoupon(USER, CODE), /유효하지 않은/);
  assert.equal(ownedRow(base.id), null);
  assert.equal(redemptionCount(), 0);

  env.PRIVATE_CARD_COUPON = `  ${CODE.toLowerCase()}  `;
  try {
    for (const round of [1, 2]) {
      const receipt = await game.redeemCoupon(USER, round === 1 ? CODE : ` ${CODE.toLowerCase()} `);
      // Receipt and state response describe the same write, and the receipt is derived from it.
      assert.deepEqual(receipt.granted, {
        credits: 0,
        low: 0,
        sr: 0,
        ssr: 0,
        cards: game.cards.length * COPIES,
        cardTypes: game.cards.length,
        copiesPerCard: COPIES
      });
      assert.equal(receipt.snapshot.inventory.length, game.cards.length + 1);
      for (const card of game.cards) {
        assert.equal(receipt.snapshot.inventory.find((entry) => entry.cardId === card.id)?.quantity, round * COPIES, `${card.id} gains ${COPIES} per grant`);
      }
      assert.ok(!JSON.stringify(receipt).includes(CODE.toLowerCase()));
    }
  } finally {
    delete env.PRIVATE_CARD_COUPON;
  }

  // Catalog grants leave the existing variant and its growth untouched.
  const kept = ownedRow('receipt-variant');
  assert.equal(kept.quantity, 7);
  assert.equal(kept.enhance_level, 9);
  assert.deepEqual(JSON.parse(kept.traits), traits);
  assert.equal(kept.base_card_id, base.id);
  assert.equal(kept.rarity_override, base.rarity);
  assert.equal(redemptionCount(), 0);

  const state = await game.getSnapshot(USER);
  assert.equal(state.completion, 100);
  assert.equal(state.inventory.reduce((sum, entry) => sum + entry.quantity, 0), game.cards.length * 2 * COPIES + 7);
  assert.ok(state.inventory.reduce((sum, entry) => sum + entry.materialCount, 0) > 0, 'material pools follow the new quantities');
});
