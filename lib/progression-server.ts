import 'server-only';
import { getDatabase } from '../db/index';
import { cards as catalog, GameError, getSnapshot, ownedRows, progressOf, type OwnedRow, ownedRowGuard, progressionGuard } from './game';
import { RARITY_ORDER, type Rarity } from './rules';
import { TRAIT_IDS, MAX_TRAIT_LEVEL, traitCost, nextRarity, dismantleReward, fragmentChance, fusionRarity, fusionMinEnhance, type TraitId, type CardProgress, type Trait } from './progression';

type Selection = { cardId: string; quantity: number };
const fail = (message: string): never => { throw new GameError('invalid_progression', message); };
const id = (raw: unknown): string => typeof raw === 'string' && raw.length > 0 && raw.length <= 128 ? raw : fail('카드를 선택해주세요.');
const integer = (raw: unknown, min: number, max: number): number => typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= min && raw <= max ? raw : fail('수량이 올바르지 않습니다.');
function selection(raw: unknown): Selection[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 500) return fail('소비할 카드를 선택해주세요.');
  const seen = new Set<string>();
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail('카드 정보가 올바르지 않습니다.');
    const cardId = id(entry.cardId);
    if (seen.has(cardId)) return fail('같은 보유 카드는 한 항목으로 입력해주세요.');
    seen.add(cardId);
    return { cardId, quantity: integer(entry.quantity, 1, 1_000_000) };
  });
}
function randomUnit(): number { return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32; }

/** Fill only missing history, at the original catalog grade (promoted legacy is an estimate). */
function initializeSpending(trait: Trait, progress: CardProgress) {
  if (trait.spentProof !== undefined) return;
  const original = catalog.find((card) => card.id === progress.baseCardId)!;
  trait.spentProof = 0;
  for (let level = 0; level < trait.level; level++) trait.spentProof += traitCost(original.rarity, level);
  if (original.rarity !== progress.rarity) trait.refundEstimated = true;
}

export async function applyProgression(userId: string, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('요청이 올바르지 않습니다.');
  const body = raw as Record<string, unknown>;
  const action = body.action;
  if (!['dismantle', 'bulk-dismantle', 'trait', 'craft-twin', 'transcend', 'fuse', 'remove-trait'].includes(String(action))) return fail('알 수 없는 성장 작업입니다.');
  if (body.preview !== undefined && typeof body.preview !== 'boolean') return fail('미리보기 값이 올바르지 않습니다.');
  const db = getDatabase();
  const rows = await ownedRows(userId);
  const owned = new Map(rows.map((row) => [row.card_id, row]));
  const lookup = (cardId: string): OwnedRow => owned.get(cardId) ?? fail('보유하지 않은 카드입니다.');
  const deckResult = await db.prepare('SELECT c.card_id FROM deck_cards c JOIN decks d ON d.id = c.deck_id WHERE d.user_id = ?').bind(userId).all();
  const deployed = new Set((deckResult.results as { card_id: string }[]).map((row) => row.card_id));
  const writes: D1PreparedStatement[] = [];
  const guard = (row: OwnedRow) => writes.push(ownedRowGuard(db, userId, row));
  const consume = (entry: Selection, bodyFirst = false) => {
    const row = lookup(entry.cardId);
    if (entry.quantity > row.quantity) return fail('보유 수량이 부족합니다.');
    if ((bodyFirst || entry.quantity === row.quantity) && deployed.has(row.card_id)) return fail('덱에 쓰는 본체 카드는 소비할 수 없습니다.');
    guard(row);
    if (bodyFirst) writes.push(progressionGuard(db, userId,
      'NOT EXISTS (SELECT 1 FROM deck_cards c JOIN decks d ON d.id = c.deck_id WHERE d.user_id = ? AND c.card_id = ?)',
      [userId, row.card_id]));
    if (entry.quantity === row.quantity) writes.push(db.prepare('DELETE FROM inventory WHERE user_id = ? AND card_id = ?').bind(userId, row.card_id));
    else writes.push(db.prepare(`UPDATE inventory SET quantity = quantity - ?${bodyFirst ? ", enhance_level = 0, traits = '[]'" : ''} WHERE user_id = ? AND card_id = ?`).bind(entry.quantity, userId, row.card_id));
  };
  const insert = (progress: CardProgress) => {
    const cardId = crypto.randomUUID();
    writes.push(db.prepare('INSERT INTO inventory (user_id, card_id, quantity, first_obtained_at, enhance_level, base_card_id, rarity_override, traits) VALUES (?, ?, 1, ?, ?, ?, ?, ?)')
      .bind(userId, cardId, new Date().toISOString(), progress.enhanceLevel, progress.baseCardId, progress.rarity, JSON.stringify(progress.traits)));
    return cardId;
  };
  let cardId: string | undefined;
  let message = '성장을 완료했어요.';
  if (action === 'dismantle' || action === 'bulk-dismantle' || action === 'fuse') {
    let selected: Selection[];
    if (action === 'bulk-dismantle') {
      if (!RARITY_ORDER.includes(body.rarity as Rarity) || typeof body.includeBase !== 'boolean') return fail('분해 조건이 올바르지 않습니다.');
      const max = integer(body.maxEnhance, 0, 15);
      selected = rows.filter((row) => progressOf(row).rarity === body.rarity)
        .map((row) => ({ cardId: row.card_id, quantity: row.quantity - (body.includeBase && row.enhance_level <= max && !deployed.has(row.card_id) ? 0 : 1) }))
        .filter((entry) => entry.quantity > 0);
      // A bulk filter must first become an exact, reviewable selection. The confirmed request
      // uses action=dismantle with these ids/counts, never reruns a mutable filter.
      if (body.preview !== true) return fail('일괄 분해는 미리보기 후 정확한 카드 목록으로 확인해주세요.');
    } else selected = selection(body.cards);
    if (!selected.length) return fail('조건에 맞는 카드가 없습니다.');
    for (const entry of selected) {
      const row = lookup(entry.cardId);
      if (entry.quantity > row.quantity) return fail('보유 수량이 부족합니다.');
      if (entry.quantity === row.quantity && deployed.has(row.card_id)) return fail('덱에 쓰는 마지막 카드는 소비할 수 없습니다.');
    }
    if (selected.reduce((sum, entry) => sum + entry.quantity, 0) > 100_000) return fail('한 번에 최대 100,000장까지 처리할 수 있습니다.');
    let consumeBodies = false;
    const proof = selected.reduce((sum, entry) => sum + entry.quantity * dismantleReward(progressOf(lookup(entry.cardId)).rarity), 0);
    const minFragments = selected.reduce((sum, entry) => sum + (fragmentChance(progressOf(lookup(entry.cardId)).rarity) >= 1 ? entry.quantity : 0), 0);
    let outputRarity: Rarity | null = null;
    let pool = catalog;
    if (action === 'fuse') {
      const count = integer(body.count, 2, 3) as 2 | 3;
      if (selected.reduce((sum, entry) => sum + entry.quantity, 0) !== count) return fail('합성 재료 수량이 맞지 않습니다.');
      const rarity = progressOf(lookup(selected[0]!.cardId)).rarity;
      outputRarity = fusionRarity(rarity, count);
      const minimum = fusionMinEnhance(rarity, count);
      consumeBodies = minimum > 0;
      if (!outputRarity || selected.some((entry) => { const p = progressOf(lookup(entry.cardId)); return p.rarity !== rarity || p.enhanceLevel < minimum || (consumeBodies && entry.quantity !== 1); })) return fail('강화 조건이 있는 합성은 각각 강화한 본체 1장씩 필요합니다.');
      if (consumeBodies && selected.some((entry) => deployed.has(entry.cardId))) return fail('덱에 쓰는 본체 카드는 소비할 수 없습니다.');
      const excluded = new Set(selected.map((entry) => progressOf(lookup(entry.cardId)).baseCardId));
      pool = catalog.filter((card) => card.rarity === outputRarity && (count === 3 || !excluded.has(card.id)));
      if (!pool.length) return fail('생성 가능한 다른 카드가 없습니다.');
    }
    const warned = selected.some((entry) => { const row = lookup(entry.cardId); const p = progressOf(row); return (consumeBodies || entry.quantity === row.quantity) && (p.enhanceLevel > 0 || p.traits.length > 0); });
    if (body.preview) return { preview: { cards: selected, proof: action === 'fuse' ? 0 : proof, minFragments: action === 'fuse' ? 0 : minFragments, warning: warned ? '강화 또는 특성이 있는 카드가 소비됩니다. 되돌릴 수 없습니다.' : '선택한 카드가 소비됩니다. 되돌릴 수 없습니다.' } };
    for (const entry of selected) consume(entry, consumeBodies);
    if (action === 'fuse') {
      const base = pool[Math.floor(randomUnit() * pool.length)]!;
      cardId = insert({ baseCardId: base.id, rarity: outputRarity!, enhanceLevel: 0, traits: [] });
      message = '합성 카드를 획득했어요.';
    } else {
      let fragments = 0;
      for (const entry of selected) {
        const chance = fragmentChance(progressOf(lookup(entry.cardId)).rarity);
        if (chance >= 1) fragments += entry.quantity;
        else for (let i = 0; i < entry.quantity; i++) if (randomUnit() < chance) fragments++;
      }
      writes.push(db.prepare('UPDATE user_game_state SET proof = proof + ?, fragments = fragments + ? WHERE user_id = ?').bind(proof, fragments, userId));
      message = `분해 완료: 임신의 증거 ${proof}개, 쌍둥이 임신의 증거 파편 ${fragments}개를 얻었어요.`;
    }
  } else if (action === 'craft-twin') {
    if (body.preview) return fail('이 작업은 미리보기를 지원하지 않습니다.');
    writes.push(db.prepare('UPDATE user_game_state SET fragments = fragments - 5, twin_proof = twin_proof + 1 WHERE user_id = ?').bind(userId));
    message = '쌍둥이 임신의 증거 1개를 만들었어요.';
  } else {
    const row = lookup(id(body.cardId));
    if (!TRAIT_IDS.includes(body.traitId as TraitId)) return fail('특성을 선택해주세요.');
    const traitId = body.traitId as TraitId;
    const progress = progressOf(row);
    const existing = progress.traits.find((trait) => trait.id === traitId);
    if (action === 'remove-trait') {
      if (!existing) return fail('제거할 특성이 없습니다.');
      initializeSpending(existing, progress);
      const proof = Math.floor(existing.spentProof! / 2);
      const warning = `선택한 특성을 완전히 제거하고 임신의 증거 ${proof}개를 환급합니다. 쌍둥이 임신의 증거 파편과 쌍둥이 임신의 증거는 환급하지 않습니다.${existing.refundEstimated ? ' 과거 지출 이력이 없어 원본 등급 기준 추정액으로 환급합니다.' : ''}`;
      if (body.preview) return { preview: { cards: [], proof, minFragments: 0, warning, expectedTraits: row.traits } };
      if (typeof body.expectedTraits !== 'string' || body.expectedTraits !== row.traits) return fail('특성 상태가 바뀌었어요. 다시 미리보기를 확인해주세요.');
      guard(row);
      writes.push(db.prepare('UPDATE inventory SET traits = ? WHERE user_id = ? AND card_id = ?').bind(JSON.stringify(progress.traits.filter((trait) => trait.id !== traitId)), userId, row.card_id));
      writes.push(db.prepare('UPDATE user_game_state SET proof = proof + ? WHERE user_id = ?').bind(proof, userId));
      message = `특성을 제거하고 임신의 증거 ${proof}개를 환급했어요.`;
    } else if (action === 'trait') {
      if (body.preview) return fail('이 작업은 미리보기를 지원하지 않습니다.');
      if ((!existing && progress.traits.length >= 2) || (existing && existing.level >= MAX_TRAIT_LEVEL)) return fail('더 강화할 수 없는 특성입니다.');
      const cost = traitCost(progress.rarity, existing?.level ?? 0);
      guard(row);
      writes.push(db.prepare('UPDATE user_game_state SET proof = proof - ? WHERE user_id = ?').bind(cost, userId));
      if (existing) {
        initializeSpending(existing, progress);
        if (!Number.isSafeInteger(existing.spentProof! + cost)) return fail('특성 지출 이력이 너무 큽니다.');
        existing.spentProof! += cost;
        existing.level++;
      } else progress.traits.push({ id: traitId, level: 1, transcended: false, spentProof: cost });
      writes.push(db.prepare('UPDATE inventory SET traits = ? WHERE user_id = ? AND card_id = ?').bind(JSON.stringify(progress.traits), userId, row.card_id));
      message = '특성을 강화했어요.';
    } else {
      const rarity = nextRarity(progress.rarity);
      if (!rarity || progress.enhanceLevel < 5 || !existing || existing.level < 10 || existing.transcended) return fail('초월 조건이 맞지 않습니다.');
      if (body.preview) return { preview: { cards: [{ cardId: row.card_id, quantity: 1 }], proof: 0, minFragments: 0, warning: '본체의 강화·특성은 초월 카드로 옮겨가고, 남은 재료는 +0·특성 없음으로 남습니다. 쌍둥이 임신의 증거 1개를 소비합니다.' } };
      guard(row);
      writes.push(db.prepare('UPDATE user_game_state SET twin_proof = twin_proof - 1 WHERE user_id = ?').bind(userId));
      for (const trait of progress.traits) initializeSpending(trait, progress);
      cardId = insert({ ...progress, rarity, traits: progress.traits.map((trait) => ({
        ...trait,
        transcended: trait.id === traitId ? true : trait.transcended
      })) });
      writes.push(db.prepare('UPDATE deck_cards SET card_id = ? WHERE card_id = ? AND deck_id IN (SELECT id FROM decks WHERE user_id = ?)').bind(cardId, row.card_id, userId));
      deployed.delete(row.card_id);
      consume({ cardId: row.card_id, quantity: 1 });
      if (row.quantity > 1) writes.push(db.prepare("UPDATE inventory SET enhance_level = 0, traits = '[]' WHERE user_id = ? AND card_id = ?").bind(userId, row.card_id));
      message = '초월 카드를 획득했어요.';
    }
  }
  try { await db.batch(writes); }
  catch (error) {
    if (error instanceof Error && /chk_user_game_state_credits|not_enough_materials|card_in_deck/.test(error.message)) {
      throw new GameError('progression_conflict', '재료가 부족하거나 보유 상태가 바뀌었어요. 다시 확인해주세요.');
    }
    throw error;
  }
  return { snapshot: await getSnapshot(userId), message, ...(cardId ? { cardId } : {}) };
}
