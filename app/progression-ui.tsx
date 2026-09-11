'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Card } from '../lib/cards';
import type { Snapshot } from '../lib/game';
import { RARITY_ORDER, rarityRank, type Rarity } from '../lib/rules';
import { cardTitle } from '../lib/collection';
import {
  MAX_TRAIT_LEVEL,
  TRAIT_IDS,
  TRAIT_LABEL,
  dismantleReward,
  fragmentChance,
  fusionMinEnhance,
  fusionRarity,
  nextRarity,
  traitCost,
  traitValue,
  type Trait,
  type TraitId
} from '../lib/progression';
import { CardArtwork, CardBadges, Icon, materialsOf, spring } from './card-ui';

/** One owned row of the snapshot inventory: the effective card plus its growth state. */
export type InventoryRow = Snapshot['inventory'][number];
export type Materials = Snapshot['materials'];
/** The exact owned copies a destructive command may spend. */
export type SpentCards = Array<{ cardId: string; quantity: number }>;
/** `preview:true` answer from POST /api/progression: what WOULD be spent, without writing. */
export type ProgressionPreview = { cards: SpentCards; proof: number; minFragments: number; warning: string };
export type ProgressionRequest =
  | { action: 'dismantle'; cards: SpentCards }
  | { action: 'bulk-dismantle'; rarity: Rarity; maxEnhance: number; includeBase: boolean }
  | { action: 'trait'; cardId: string; traitId: TraitId }
  | { action: 'craft-twin' }
  | { action: 'transcend'; cardId: string; traitId: TraitId }
  | { action: 'fuse'; cards: SpentCards; count: 2 | 3 };
export type ProgressionReply = { message: string; preview?: ProgressionPreview };
/** Owner of the request state: posts to /api/progression and refreshes the snapshot. Throws on refusal. */
export type RunProgression = (body: ProgressionRequest, options?: { preview?: boolean }) => Promise<ProgressionReply>;

/** What each trait does, in the player's words. Effects themselves come from lib/progression. */
const TRAIT_HINT: Record<string, string> = {
  damage: '내 속성 공격 피해 증가',
  synergy: '속성 연계 배율 추가 증가',
  resist_earth: '대지 피해 감소',
  resist_water: '물 피해 감소',
  resist_fire: '불 피해 감소',
  resist_grass: '풀 피해 감소',
  resist_dark: '암흑 피해 감소'
};

const percent = (value: number) => `${Math.round(value * 1000) / 10}%`;
const fragmentText = (rarity: Rarity) => {
  const chance = fragmentChance(rarity);
  return chance >= 1 ? '파편 확정' : `파편 ${percent(chance)}`;
};
const nextTrait = (trait: Trait): Trait => ({ ...trait, level: Math.min(MAX_TRAIT_LEVEL, trait.level + 1) });

/** Growth home: owned variants, materials, fusion and bulk dismantle. */
export function GrowthView({ user, snapshot, run, busy, onOpenCard }: {
  user: { email: string; displayName: string } | null;
  snapshot: Snapshot;
  run: RunProgression;
  busy: boolean;
  onOpenCard: (card: Card) => void;
}) {
  const [tab, setTab] = useState<'cards' | 'fuse' | 'bulk'>('cards');
  const [highFirst, setHighFirst] = useState(true);
  const [crafting, setCrafting] = useState(false);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const rows = snapshot.inventory;
  const materials = snapshot.materials;
  const working = busy || pending;

  const report = (text: string, error = false) => setNote({ text, error });
  const fail = (error: unknown) => report(error instanceof Error ? error.message : '연결을 확인한 뒤 다시 시도해주세요.', true);

  // 등급 내림차순이 기본. 같은 등급 안에서는 도감 번호 순서를 지킨다.
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const byRarity = rarityRank(a.card.rarity) - rarityRank(b.card.rarity);
    const byNumber = a.card.version - b.card.version;
    return (highFirst ? byRarity : -byRarity) || byNumber || a.cardId.localeCompare(b.cardId);
  }), [rows, highFirst]);

  async function craftTwin() {
    setPending(true);
    setNote(null);
    try {
      const reply = await run({ action: 'craft-twin' });
      report(reply.message || '쌍둥이 증거를 만들었어요.');
      setCrafting(false);
    } catch (error) {
      fail(error);
    } finally {
      setPending(false);
    }
  }

  if (!user) {
    return (
      <section className="growth-view" aria-labelledby="growth-title">
        <header className="section-head">
          <div><p className="eyebrow">CARD GROWTH</p><h1 id="growth-title">카드 성장.</h1><p>증거와 파편으로 특성을 열고, 합성과 초월로 등급을 올립니다.</p></div>
        </header>
        <section className="welcome-strip">
          <span><Icon name="sparkle" /><strong>성장은 로그인 후에.</strong><span>보유 카드의 특성과 분해 기록이 내 계정에 남아요.</span></span>
          <a href={`/signin-with-chatgpt?return_to=${encodeURIComponent('/#growth')}`}>ChatGPT로 시작하기<Icon name="arrow" /></a>
        </section>
      </section>
    );
  }

  return (
    <section className="growth-view" aria-labelledby="growth-title">
      <header className="section-head">
        <div>
          <p className="eyebrow">CARD GROWTH</p>
          <h1 id="growth-title">카드 성장.</h1>
          <p>같은 카드를 갈아 증거를 모으고, 특성·합성·초월로 카드를 키웁니다.</p>
        </div>
      </header>

      <div className="growth-wallet" aria-label="보유 재료">
        <span className="wallet-chip"><small>하급 뽑기권</small><strong>{snapshot.tickets.low.toLocaleString('ko-KR')}</strong></span>
        <span className="wallet-chip"><small>일반 뽑기권</small><strong>{snapshot.credits.toLocaleString('ko-KR')}</strong></span>
        <span className="wallet-chip"><small>SR 뽑기권</small><strong>{snapshot.tickets.sr.toLocaleString('ko-KR')}</strong></span>
        <span className="wallet-chip"><small>SSR 뽑기권</small><strong>{snapshot.tickets.ssr.toLocaleString('ko-KR')}</strong></span>
        <span className="wallet-chip is-proof"><small>증거</small><strong>{materials.proof.toLocaleString('ko-KR')}</strong></span>
        <span className="wallet-chip is-fragment"><small>파편</small><strong>{materials.fragments.toLocaleString('ko-KR')}</strong></span>
        <span className="wallet-chip is-twin"><small>쌍둥이 증거</small><strong>{materials.twinProof.toLocaleString('ko-KR')}</strong></span>
        <button className="wallet-chip is-action" disabled={working || materials.fragments < 5} onClick={() => { setNote(null); setCrafting(true); }}>
          <small>파편 5개 → 쌍둥이 증거</small><strong>{materials.fragments >= 5 ? '합성하기' : `파편 ${5 - materials.fragments}개 부족`}</strong>
        </button>
      </div>

      <div className="growth-tabs" role="group" aria-label="성장 메뉴">
        {([['cards', '내 카드'], ['fuse', '합성'], ['bulk', '일괄 분해']] as const).map(([value, label]) => (
          <button key={value} aria-pressed={tab === value} disabled={working} onClick={() => { setTab(value); setNote(null); }}>{label}</button>
        ))}
      </div>

      {note && <p className={`feedback ${note.error ? 'error' : 'success'}`} role={note.error ? 'alert' : 'status'}><Icon name={note.error ? 'clock' : 'check'} />{note.text}</p>}

      {tab === 'cards' && (
        <>
          <div className="growth-sort" role="group" aria-label="정렬">
            <button aria-pressed={highFirst} onClick={() => setHighFirst(true)}>등급 내림</button>
            <button aria-pressed={!highFirst} onClick={() => setHighFirst(false)}>등급 오름</button>
          </div>
          {sorted.length ? (
            <ul className="growth-grid">
              {sorted.map((row) => (
                <li key={row.cardId} className="growth-item">
                  <button className="growth-art" onClick={() => onOpenCard(row.card)} aria-label={`${cardTitle(row.card)} 성장 정보 열기`}>
                    <CardArtwork card={row.card} quantity={row.quantity} materialCount={materialsOf(row, rows)} enhanceLevel={row.enhanceLevel} />
                  </button>
                  <strong className="growth-name">{cardTitle(row.card)}</strong>
                  <CardBadges card={row.card} progress={row} />
                  <p className="growth-traits">
                    {row.traits.length
                      ? row.traits.map((trait) => `${TRAIT_LABEL[trait.id]} ${trait.level}${trait.transcended ? ' · 초월' : ''}`).join(' · ')
                      : '특성 없음 · 2개까지 열 수 있어요'}
                  </p>
                  <button className="text-button" onClick={() => onOpenCard(row.card)}>성장 · 분해 · 초월<Icon name="arrow" /></button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-state"><Icon name="pack" /><h2>아직 키울 카드가 없어요.</h2><p>카드팩을 열어 첫 카드를 만나보세요.</p></div>
          )}
        </>
      )}

      {tab === 'fuse' && <FusePanel rows={rows} run={run} busy={working} onPending={setPending} onNote={report} />}
      {tab === 'bulk' && <BulkDismantlePanel rows={rows} run={run} busy={working} onPending={setPending} onNote={report} />}

      <AnimatePresence>
        {crafting && (
          <ConfirmSheet
            key="craft-twin"
            title="파편 5개를 합성할까요?"
            confirmLabel="쌍둥이 증거 만들기"
            busy={working}
            onConfirm={() => void craftTwin()}
            onClose={() => setCrafting(false)}
          >
            <ul className="confirm-list">
              <li><span>파편</span><strong>-5</strong></li>
              <li><span>쌍둥이 임신의 증거</span><strong>+1</strong></li>
            </ul>
            <p className="confirm-note">쌍둥이 증거는 한 장을 초월할 때 1개 씁니다.</p>
          </ConfirmSheet>
        )}
      </AnimatePresence>
    </section>
  );
}

/** Fusion: same effective rarity, 2 cards trade kind, 3 cards climb a rarity. */
function FusePanel({ rows, run, busy, onPending, onNote }: {
  rows: InventoryRow[];
  run: RunProgression;
  busy: boolean;
  onPending: (pending: boolean) => void;
  onNote: (text: string, error?: boolean) => void;
}) {
  const [count, setCount] = useState<2 | 3>(3);
  /** 한 행에서 여러 장을 넣을 수 있다(중복 장수 합성). 수량 합계가 count와 같아야 한다. */
  const [picks, setPicks] = useState<Array<{ cardId: string; quantity: number }>>([]);
  const [confirming, setConfirming] = useState(false);

  const rarityOptions = useMemo(() => RARITY_ORDER.filter((rarity) => rows.some((row) => row.card.rarity === rarity)), [rows]);
  const [rarity, setRarity] = useState<Rarity>('N');
  useEffect(() => {
    if (rarityOptions.length && !rarityOptions.includes(rarity)) setRarity(rarityOptions[0]!);
  }, [rarityOptions, rarity]);

  const pool = useMemo(() => rows.filter((row) => row.card.rarity === rarity), [rows, rarity]);
  const minEnhance = fusionMinEnhance(rarity, count);
  const target = fusionRarity(rarity, count);
  const climb = count === 3;
  const legal = fusionRarity(rarity, count) !== null;

  // Drop picks that left the pool or fell past the count; keep the array identity when nothing moved.
  useEffect(() => {
    setPicks((current) => {
      const next: Array<{ cardId: string; quantity: number }> = [];
      let total = 0;
      for (const pick of current) {
        const row = pool.find((item) => item.cardId === pick.cardId);
        if (!row || total >= count) continue;
        const quantity = Math.max(1, Math.min(pick.quantity, row.quantity, count - total));
        next.push({ cardId: pick.cardId, quantity });
        total += quantity;
      }
      const same = next.length === current.length && next.every((pick, index) => pick.cardId === current[index]!.cardId && pick.quantity === current[index]!.quantity);
      return same ? current : next;
    });
  }, [pool, count]);

  const total = picks.reduce((sum, pick) => sum + pick.quantity, 0);
  const picked = picks.flatMap((pick) => {
    const row = pool.find((item) => item.cardId === pick.cardId);
    return row ? [{ row, quantity: pick.quantity }] : [];
  });
  const kindOf = (row: InventoryRow) => row.baseCardId || row.cardId;
  const isPicked = (cardId: string) => picks.some((pick) => pick.cardId === cardId);
  const pickedQuantity = (cardId: string) => picks.find((pick) => pick.cardId === cardId)?.quantity ?? 0;

  function toggle(row: InventoryRow) {
    setPicks((current) => {
      if (current.some((pick) => pick.cardId === row.cardId)) return current.filter((pick) => pick.cardId !== row.cardId);
      // 2장 합성은 서로 다른 기본 종류여야 결과 후보가 남는다.
      if (count === 2 && current.some((pick) => kindOf(pool.find((item) => item.cardId === pick.cardId) ?? row) === kindOf(row))) return current;
      if (current.reduce((sum, pick) => sum + pick.quantity, 0) >= count) return current;
      return [...current, { cardId: row.cardId, quantity: 1 }];
    });
  }

  function bump(row: InventoryRow, delta: number) {
    setPicks((current) => {
      const others = current.reduce((sum, pick) => sum + (pick.cardId === row.cardId ? 0 : pick.quantity), 0);
      return current.map((pick) => {
        if (pick.cardId !== row.cardId) return pick;
        const cap = Math.max(1, Math.min(row.quantity, count, count - others));
        const quantity = Math.max(1, Math.min(cap, pick.quantity + delta));
        return quantity === pick.quantity ? pick : { ...pick, quantity };
      });
    });
  }

  async function commit() {
    onPending(true);
    try {
      const reply = await run({ action: 'fuse', cards: picks.map((pick) => ({ cardId: pick.cardId, quantity: pick.quantity })), count });
      onNote(reply.message || '합성했어요.');
      setPicks([]);
      setConfirming(false);
    } catch (error) {
      onNote(error instanceof Error ? error.message : '연결을 확인한 뒤 다시 시도해주세요.', true);
    } finally {
      onPending(false);
    }
  }

  const promoted = target ?? nextRarity(rarity) ?? null;
  const targetText = climb
    ? (legal ? (promoted ? `${promoted} 등급 카드 1장` : '다음 등급 카드 1장') : 'UR은 더 올릴 수 없어요')
    : `${rarity} 등급의 다른 기본 종류 카드 1장`;

  return (
    <section className="fuse-panel" aria-labelledby="fuse-title">
      <div className="growth-block-head">
        <h2 id="fuse-title">합성</h2>
        <p className="deck-hint"><Icon name="sparkle" />결과 카드는 +0 · 특성 없음으로 새로 만들어집니다.</p>
      </div>
      <div className="fuse-rules">
        <span className="fuse-rule"><strong>3장</strong> 같은 등급 → 다음 등급 1장 (SR 재료 각 +1, SSR 재료 각 +2 이상)</span>
        <span className="fuse-rule"><strong>2장</strong> 같은 등급 → 같은 등급의 다른 기본 종류 1장</span>
        <span className="fuse-rule">UR 승급 · XR 합성은 없어요.</span>
        <span className="fuse-rule">결과 후보가 재료와 같은 기본 종류뿐이면 소비 없이 거절돼요.</span>
      </div>

      <div className="fuse-controls">
        <div className="sort-toggle" role="group" aria-label="합성 매수">
          {([3, 2] as const).map((value) => <button key={value} aria-pressed={count === value} onClick={() => setCount(value)}>{value}장 합성</button>)}
        </div>
        <div className="rarity-filters" role="group" aria-label="합성 등급">
          {rarityOptions.map((value) => (
            <button key={value} className={`rarity-${value}`} aria-pressed={rarity === value} onClick={() => setRarity(value)}><i />{value}</button>
          ))}
        </div>
      </div>

      <p className="fuse-target" role="status">
        <Icon name={legal ? 'sparkle' : 'clock'} />{rarity} 재료 {count}장 → <strong>{targetText}</strong>
        {minEnhance > 0 && <span> · 재료는 각 +{minEnhance} 이상이어야 해요</span>}
      </p>

      {pool.length ? (
        <ul className="fuse-grid">
          {pool.map((row) => {
            const chosen = isPicked(row.cardId);
            const chosenCount = pickedQuantity(row.cardId);
            const tooLow = row.enhanceLevel < minEnhance;
            const sameKind = count === 2 && picks.some((pick) => pick.cardId !== row.cardId && kindOf(pool.find((item) => item.cardId === pick.cardId) ?? row) === kindOf(row));
            const blocked = !legal || tooLow || sameKind;
            return (
              <li key={row.cardId} className={`fuse-item ${chosen ? 'is-selected' : ''} ${blocked ? 'is-blocked' : ''}`}>
                <button
                  className="fuse-pick"
                  aria-pressed={chosen}
                  aria-disabled={!chosen && (blocked || total >= count)}
                  aria-label={`${cardTitle(row.card)}${chosen ? ' 합성 재료에서 빼기' : ' 합성 재료로 넣기'}`}
                  onClick={() => { if (!chosen && (blocked || total >= count)) return; toggle(row); }}
                >
                  <CardArtwork card={row.card} quantity={row.quantity} materialCount={materialsOf(row, rows)} enhanceLevel={row.enhanceLevel} />
                  {chosen && <span className="picker-order">{chosenCount}</span>}
                  <span className="picker-check" aria-hidden="true"><Icon name={chosen ? 'check' : 'sparkle'} /></span>
                </button>
                {chosen && count === 3 ? (
                  <div className="fuse-count" role="group" aria-label={`${cardTitle(row.card)} 재료 수량`}>
                    <button className="fuse-step" disabled={busy || chosenCount <= 1} onClick={() => bump(row, -1)} aria-label="한 장 줄이기">−</button>
                    <span aria-live="polite">{chosenCount}장</span>
                    <button className="fuse-step" disabled={busy || total >= count || chosenCount >= Math.min(row.quantity, count)} onClick={() => bump(row, 1)} aria-label="한 장 더 넣기">+</button>
                  </div>
                ) : (
                  <span className="fuse-meta">{tooLow ? `+${minEnhance} 필요` : sameKind ? '다른 기본 종류 필요' : `보유 ${row.quantity}장`}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="deck-note">이 등급의 보유 카드가 없어요.</p>
      )}

      <div className="sticky-bar">
        <span className="deck-save-state" role="status">
          <Icon name={total === count ? 'check' : 'clock'} />{total} / {count}장 선택{minEnhance > 0 ? ` · 각 +${minEnhance} 이상` : ''}
        </span>
        <button className="btn btn-primary" disabled={busy || total !== count || !legal} onClick={() => setConfirming(true)}>
          합성 확인
        </button>
      </div>

      <AnimatePresence>
        {confirming && (
          <ConfirmSheet
            key="fuse"
            title={`${rarity} 카드 ${count}장을 합성할까요?`}
            confirmLabel="합성하기"
            busy={busy}
            onConfirm={() => void commit()}
            onClose={() => setConfirming(false)}
          >
            <ul className="confirm-list">
              {picked.map(({ row, quantity }) => (
                <li key={row.cardId}><span>{cardTitle(row.card)}{row.enhanceLevel > 0 ? ` +${row.enhanceLevel}` : ''}</span><strong>{quantity}장 소모</strong></li>
              ))}
            </ul>
            <p className="confirm-note">{targetText}이 만들어집니다. 결과 카드는 +0 · 특성 없음으로 시작합니다.</p>
          </ConfirmSheet>
        )}
      </AnimatePresence>
    </section>
  );
}

/** Bulk dismantle: only an exact rarity, an enhance ceiling, and optionally base copies. */
function BulkDismantlePanel({ rows, run, busy, onPending, onNote }: {
  rows: InventoryRow[];
  run: RunProgression;
  busy: boolean;
  onPending: (pending: boolean) => void;
  onNote: (text: string, error?: boolean) => void;
}) {
  const [rarity, setRarity] = useState<Rarity>('N');
  const [maxEnhance, setMaxEnhance] = useState(0);
  const [includeBase, setIncludeBase] = useState(false);
  const [preview, setPreview] = useState<ProgressionPreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const names = useMemo(() => new Map(rows.map((row) => [row.cardId, cardTitle(row.card)])), [rows]);

  async function loadPreview() {
    onPending(true);
    try {
      const reply = await run({ action: 'bulk-dismantle', rarity, maxEnhance, includeBase }, { preview: true });
      const next = reply.preview ?? null;
      setPreview(next);
      if (next?.cards.length) setConfirming(true);
      else onNote('조건에 맞는 카드가 없어요. 등급과 강화 상한을 바꿔보세요.', true);
    } catch (error) {
      onNote(error instanceof Error ? error.message : '연결을 확인한 뒤 다시 시도해주세요.', true);
    } finally {
      onPending(false);
    }
  }

  async function commit() {
    if (!preview) return;
    onPending(true);
    try {
      // 미리보기와 정확히 같은 목록을 그대로 보낸다: 서버가 계산한 대상만 소모된다.
      const reply = await run({ action: 'dismantle', cards: preview.cards });
      onNote(reply.message || '분해했어요.');
      setPreview(null);
      setConfirming(false);
    } catch (error) {
      onNote(error instanceof Error ? error.message : '연결을 확인한 뒤 다시 시도해주세요.', true);
    } finally {
      onPending(false);
    }
  }

  return (
    <section className="bulk-panel" aria-labelledby="bulk-title">
      <div className="growth-block-head">
        <h2 id="bulk-title">일괄 분해</h2>
        <p className="deck-hint"><Icon name="clock" />덱에 쓰는 마지막 1장은 서버가 보호합니다.</p>
      </div>
      <div className="bulk-controls">
        <div className="rarity-filters" role="group" aria-label="분해 등급">
          {RARITY_ORDER.map((value) => (
            <button key={value} className={`rarity-${value}`} aria-pressed={rarity === value} onClick={() => setRarity(value)}><i />{value}</button>
          ))}
        </div>
        <label className="bulk-field">
          <span>강화 상한</span>
          <select value={maxEnhance} onChange={(event) => setMaxEnhance(Number(event.target.value))}>
            {Array.from({ length: 16 }, (_, level) => <option key={level} value={level}>+{level} 이하</option>)}
          </select>
        </label>
        <label className="bulk-check">
          <input type="checkbox" checked={includeBase} onChange={(event) => setIncludeBase(event.target.checked)} />
          <span>본체(남은 1장)까지 포함</span>
        </label>
      </div>
      <p className="deck-note">기본값은 중복분만 분해합니다. 등급 1장당 증거 {dismantleReward(rarity)}개 · {fragmentText(rarity)}.</p>
      <div className="sticky-bar">
        <span className="deck-save-state"><Icon name="sparkle" />{rarity} · +{maxEnhance} 이하{includeBase ? ' · 본체 포함' : ' · 중복만'}</span>
        <button className="btn btn-primary" disabled={busy} onClick={() => void loadPreview()}>대상 미리보기</button>
      </div>

      <AnimatePresence>
        {confirming && preview && (
          <ConfirmSheet
            key="bulk"
            title={`${rarity} 카드 ${preview.cards.reduce((sum, card) => sum + card.quantity, 0)}장을 분해할까요?`}
            confirmLabel="분해하기"
            busy={busy}
            onConfirm={() => void commit()}
            onClose={() => { setConfirming(false); setPreview(null); }}
          >
            <ul className="confirm-list">
              <li><span>증거</span><strong>+{preview.proof}개</strong></li>
              <li><span>파편</span><strong>최소 +{preview.minFragments}개</strong></li>
            </ul>
            <ul className="confirm-list is-targets">
              {preview.cards.map((entry) => <li key={entry.cardId}><span>{names.get(entry.cardId) ?? entry.cardId}</span><strong>{entry.quantity}장</strong></li>)}
            </ul>
            {preview.warning && <p className="confirm-note">{preview.warning}</p>}
          </ConfirmSheet>
        )}
      </AnimatePresence>
    </section>
  );
}

/** Trait slots for one owned card: pick from 0 to 2, then raise them to 20. */
export function TraitPanel({ card, row, materials, run, busy }: {
  card: Card;
  row: InventoryRow;
  materials: Materials;
  run: RunProgression;
  busy: boolean;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const working = busy || pending !== null;
  const openSlots = Math.max(0, 2 - row.traits.length);
  const available = TRAIT_IDS.filter((id) => !row.traits.some((trait) => trait.id === id));

  async function apply(traitId: TraitId) {
    setPending(traitId);
    setNote(null);
    try {
      const reply = await run({ action: 'trait', cardId: row.cardId, traitId });
      setNote({ text: reply.message || `${TRAIT_LABEL[traitId]} 특성을 강화했어요.`, error: false });
    } catch (error) {
      setNote({ text: error instanceof Error ? error.message : '연결을 확인한 뒤 다시 시도해주세요.', error: true });
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="trait-panel" aria-labelledby={`trait-title-${row.cardId}`}>
      <span className="eyebrow">TRAITS · {row.traits.length} / 2</span>
      <h3 id={`trait-title-${row.cardId}`}>특성</h3>
      <p className="trait-intro">서로 다른 특성을 최대 2개까지. 선택하면 첫 +1 비용이 바로 차감되고, 5레벨마다 효과가 크게 오릅니다.</p>
      {row.traits.length ? (
        <ul className="trait-list">
          {row.traits.map((trait) => {
            const cap = trait.level >= MAX_TRAIT_LEVEL;
            const cost = traitCost(card.rarity, trait.level);
            const short = materials.proof < cost;
            const jump = (trait.level + 1) % 5 === 0;
            return (
              <li key={trait.id} className={`trait-row ${trait.transcended ? 'is-transcended' : ''}`}>
                <div className="trait-head">
                  <strong>{TRAIT_LABEL[trait.id]}</strong>
                  <span className="trait-level">{trait.transcended ? '초월 · ' : ''}+{trait.level} / {MAX_TRAIT_LEVEL}</span>
                </div>
                <p className="trait-effect">
                  <Icon name="sparkle" />{TRAIT_HINT[trait.id] ?? '전투 보정'} <strong>{percent(traitValue(trait))}</strong>
                </p>
                <p className="trait-next">
                  {cap
                    ? '최대 레벨입니다. 초월하면 효과가 1.75배가 됩니다.'
                    : <>다음 +{trait.level + 1} · 증거 <strong>{cost}</strong>개 · 효과 {percent(traitValue(nextTrait(trait)))}{jump ? ' · 5레벨 급등' : ''}</>}
                </p>
                <button
                  className="btn btn-dark"
                  disabled={working || cap || short}
                  onClick={() => void apply(trait.id)}
                >
                  {cap ? '최대 특성' : short ? `증거 ${cost - materials.proof}개 부족` : `+${trait.level + 1} 강화 · 증거 ${cost}개`}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {openSlots > 0 ? (
        <div className="trait-open">
          <p className="trait-open-label">특성 선택 <span>{openSlots}칸 남음</span> · 첫 +1 비용 증거 {traitCost(card.rarity, 0)}개</p>
          <ul className="trait-choices">
            {available.map((id) => (
              <li key={id}>
                <button className="trait-choice" disabled={working || materials.proof < traitCost(card.rarity, 0)} onClick={() => void apply(id)}>
                  <strong>{TRAIT_LABEL[id]}</strong>
                  <small>{TRAIT_HINT[id] ?? '전투 보정'}</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {note && <p className={`enhance-note ${note.error ? 'is-error' : ''}`} role={note.error ? 'alert' : 'status'}>{note.text}</p>}
    </section>
  );
}

/** Dismantle one owned card, with an exact sold-count preview before the write. */
export function DismantlePanel({ card, row, run, busy }: {
  card: Card;
  row: InventoryRow;
  run: RunProgression;
  busy: boolean;
}) {
  const [quantity, setQuantity] = useState(1);
  const [preview, setPreview] = useState<ProgressionPreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const working = busy || pending;
  const max = Math.max(1, row.quantity);
  const chosen = Math.min(quantity, max);

  async function loadPreview() {
    setPending(true);
    setNote(null);
    try {
      const reply = await run({ action: 'dismantle', cards: [{ cardId: row.cardId, quantity: chosen }] }, { preview: true });
      setPreview(reply.preview ?? null);
      setConfirming(true);
    } catch (error) {
      setNote({ text: error instanceof Error ? error.message : '연결을 확인한 뒤 다시 시도해주세요.', error: true });
    } finally {
      setPending(false);
    }
  }

  async function commit() {
    if (!preview) return;
    setPending(true);
    try {
      const reply = await run({ action: 'dismantle', cards: preview.cards });
      setNote({ text: reply.message || '분해했어요.', error: false });
      setPreview(null);
      setConfirming(false);
      setQuantity(1);
    } catch (error) {
      setNote({ text: error instanceof Error ? error.message : '연결을 확인한 뒤 다시 시도해주세요.', error: true });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="dismantle-panel" aria-labelledby={`dismantle-title-${row.cardId}`}>
      <span className="eyebrow">DISMANTLE</span>
      <h3 id={`dismantle-title-${row.cardId}`}>분해</h3>
      <p className="dismantle-intro">보유 {row.quantity}장 · 1장당 증거 {dismantleReward(card.rarity)}개 · {fragmentText(card.rarity)}. 덱에 쓰는 마지막 1장은 보호됩니다.</p>
      <div className="dismantle-controls">
        <label className="bulk-field">
          <span>분해 수량</span>
          <input type="number" min={1} max={max} value={chosen} inputMode="numeric" onChange={(event) => setQuantity(Math.max(1, Math.min(max, Math.floor(Number(event.target.value) || 1))))} />
        </label>
        <button className="text-button" onClick={() => setQuantity(max)} disabled={working || max === 1}>전부 ({max}장)</button>
      </div>
      <button className="btn btn-dark" disabled={working} onClick={() => void loadPreview()}>
        {pending ? '확인 중…' : `${chosen}장 분해 미리보기`}
      </button>
      {note && <p className={`enhance-note ${note.error ? 'is-error' : ''}`} role={note.error ? 'alert' : 'status'}>{note.text}</p>}

      <AnimatePresence>
        {confirming && preview && (
          <ConfirmSheet
            key="dismantle"
            title="이 카드를 분해할까요?"
            confirmLabel="분해하기"
            busy={working}
            onConfirm={() => void commit()}
            onClose={() => { setConfirming(false); setPreview(null); }}
          >
            <ul className="confirm-list is-targets">
              {preview.cards.map((entry) => <li key={entry.cardId}><span>{cardTitle(card)}</span><strong>{entry.quantity}장</strong></li>)}
            </ul>
            <ul className="confirm-list">
              <li><span>증거</span><strong>+{preview.proof}개</strong></li>
              <li><span>파편</span><strong>최소 +{preview.minFragments}개</strong></li>
            </ul>
            {preview.warning && <p className="confirm-note">{preview.warning}</p>}
          </ConfirmSheet>
        )}
      </AnimatePresence>
    </section>
  );
}

/** Transcend one trait: needs +5 enhance, a non-transcended trait at +10, and one twin proof. */
export function TranscendPanel({ card, row, materials, run, busy }: {
  card: Card;
  row: InventoryRow;
  materials: Materials;
  run: RunProgression;
  busy: boolean;
}) {
  const [traitId, setTraitId] = useState<TraitId | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const working = busy || pending;
  const target = nextRarity(card.rarity);
  const capped = card.rarity === 'XR' || !target;
  const eligible = row.traits.filter((trait) => !trait.transcended && trait.level >= 10);
  const chosen = traitId ?? eligible[0]?.id ?? null;
  const enhanced = row.enhanceLevel >= 5;
  const affordable = materials.twinProof >= 1;
  const ready = !capped && enhanced && !!chosen && affordable;

  async function commit() {
    if (!chosen) return;
    setPending(true);
    try {
      const reply = await run({ action: 'transcend', cardId: row.cardId, traitId: chosen });
      setNote({ text: reply.message || '초월했어요.', error: false });
      setConfirming(false);
    } catch (error) {
      setNote({ text: error instanceof Error ? error.message : '연결을 확인한 뒤 다시 시도해주세요.', error: true });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="transcend-panel" aria-labelledby={`transcend-title-${row.cardId}`}>
      <span className="eyebrow">TRANSCEND</span>
      <h3 id={`transcend-title-${row.cardId}`}>초월</h3>
      <p className="transcend-intro">한 번에 1장만 초월합니다. 선택한 특성만 초월하고, 강화 단계와 다른 특성은 그대로 남습니다.</p>
      <ul className="transcend-conditions">
        <li data-met={!capped}><Icon name={capped ? 'clock' : 'check'} />등급 여유<span>{capped ? 'XR은 더 올릴 수 없어요' : `${card.rarity} → ${target}`}</span></li>
        <li data-met={enhanced}><Icon name={enhanced ? 'check' : 'clock'} />강화 +5 이상<span>현재 +{row.enhanceLevel}</span></li>
        <li data-met={eligible.length > 0}><Icon name={eligible.length ? 'check' : 'clock'} />비초월 특성 +10<span>{eligible.length ? eligible.map((trait) => TRAIT_LABEL[trait.id]).join(' · ') : '아직 +10 특성이 없어요'}</span></li>
        <li data-met={affordable}><Icon name={affordable ? 'check' : 'clock'} />쌍둥이 증거 1개<span>보유 {materials.twinProof}개</span></li>
      </ul>
      {eligible.length > 0 ? (
        <div className="sort-toggle" role="group" aria-label="초월할 특성">
          {eligible.map((trait) => (
            <button key={trait.id} aria-pressed={chosen === trait.id} onClick={() => setTraitId(trait.id)}>{TRAIT_LABEL[trait.id]} +{trait.level}</button>
          ))}
        </div>
      ) : null}
      <button className="btn btn-primary" disabled={working || !ready} onClick={() => setConfirming(true)}>
        {capped ? '초월 완료' : !enhanced ? '강화 +5 필요' : !chosen ? '특성 +10 필요' : !affordable ? '쌍둥이 증거 1개 필요' : '초월 확인'}
      </button>
      {note && <p className={`enhance-note ${note.error ? 'is-error' : ''}`} role={note.error ? 'alert' : 'status'}>{note.text}</p>}

      <AnimatePresence>
        {confirming && chosen && (
          <ConfirmSheet
            key="transcend"
            title="이 카드를 초월할까요?"
            confirmLabel="초월하기"
            busy={working}
            onConfirm={() => void commit()}
            onClose={() => setConfirming(false)}
          >
            <ul className="confirm-list">
              <li><span>{cardTitle(card)} · {TRAIT_LABEL[chosen]} 초월</span><strong>+1.75배</strong></li>
              <li><span>등급</span><strong>{card.rarity} → {target}</strong></li>
              <li><span>쌍둥이 임신의 증거</span><strong>-1</strong></li>
            </ul>
            <p className="confirm-note">강화 +{row.enhanceLevel}과 다른 특성{row.traits.filter((trait) => trait.id !== chosen).length ? ` (${row.traits.filter((trait) => trait.id !== chosen).map((trait) => TRAIT_LABEL[trait.id]).join(' · ')})` : ''}은 그대로 유지됩니다.</p>
          </ConfirmSheet>
        )}
      </AnimatePresence>
    </section>
  );
}

/** Native modal used for every spend confirmation. Escape and the backdrop only close when idle. */
function ConfirmSheet({ title, confirmLabel, busy, onConfirm, onClose, children }: {
  title: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    const element = dialog.current;
    element?.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      element?.close();
      document.body.style.overflow = overflow;
      previous?.focus({ preventScroll: true });
    };
  }, []);

  return (
    <motion.dialog
      ref={dialog}
      className="confirm-dialog"
      aria-label={title}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
    >
      <motion.section className="confirm-sheet" initial={reduced ? { opacity: 0 } : { opacity: 0, y: 22 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? { opacity: 0 } : { opacity: 0, y: 12 }} transition={spring}>
        <h2>{title}</h2>
        <div className="confirm-body">{children}</div>
        <div className="confirm-actions">
          <button className="btn btn-dark" autoFocus disabled={busy} onClick={onClose}>취소</button>
          <button className="btn btn-primary" disabled={busy} onClick={onConfirm}>{busy ? '처리 중…' : confirmLabel}</button>
        </div>
      </motion.section>
    </motion.dialog>
  );
}
