'use client';

import { motion, useDragControls, useMotionTemplate, useMotionValue, useReducedMotion, useSpring, animate } from 'motion/react';
import { memo, useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import type { Card } from '../lib/cards';
import { catalogCard, battleStats } from '../lib/battle/stats';
import { enhanceSkillsForCard, scaleAbility } from '../lib/battle/enhance-skills';
import { applyEnhance, enhanceCost, enhanceMaterials, MAX_ENHANCE } from '../lib/enhance';
import { ELEMENT_LABEL, STATUS_LABEL, type AbilityOp, type CardBattleStats, type Element } from '../lib/battle/types';
import * as battleTypes from '../lib/battle/types';
import type { Rarity } from '../lib/rules';
import type { CardProgress, Trait } from '../lib/progression';
import { cardTitle, projectedPosition } from '../lib/collection';

export const spring = { type: 'spring' as const, stiffness: 360, damping: 34, mass: 0.9 };
export const gentleSpring = { type: 'spring' as const, stiffness: 230, damping: 29, mass: 0.85 };

const paths = {
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  back: 'M19 12H5m6-6-6 6 6 6',
  close: 'm6 6 12 12M6 18 18 6',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  home: 'm3 10 9-7 9 7v10H3zM9 20v-7h6v7',
  pack: 'M5 3h14v18H5zM5 7h14M5 17h14m-7-7-2 2 2 2 2-2z',
  ticket: 'M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4zM15 5v2m0 3v4m0 3v2',
  search: 'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Zm5.5-2 5 5',
  check: 'm5 12 4 4L19 6',
  sparkle: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
  clock: 'M12 8v5l3 2m6-3a9 9 0 1 0-18 0 9 9 0 0 0 18 0',
  chevron: 'm9 5 7 7-7 7',
  logout: 'M9 4H4v16h5m5-13 5 5-5 5m-6-5h13',
  hand: 'M8 13V5a2 2 0 0 1 4 0v7-4a2 2 0 0 1 4 0v4-2a2 2 0 0 1 4 0v6c0 4-3 6-6 6h-1c-3 0-4-2-6-4l-4-5a2 2 0 0 1 3-2l2 2',
} as const;

export function Icon({ name, className = '' }: { name: keyof typeof paths; className?: string }) {
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function Brand({ children }: { children?: ReactNode }) {
  return <><span className="brand-symbol" aria-hidden="true"><i /><i /><i /><i /></span><span>limketmon<span className="brand-period">.</span></span>{children}</>;
}

type CardArtworkProps = { card: Card; quantity?: number; materialCount?: number; enhanceLevel?: number; priority?: boolean; unowned?: boolean };

export type MaterialSource = { materialCount?: number; quantity?: number; baseCardId?: string; cardId?: string };

/** Shared enhance materials. Prefer snapshot.materialCount; else sum quantity-1 per same baseCardId. */
export function materialsOf(row: MaterialSource | undefined, inventory: MaterialSource[] = []): number {
  if (row && typeof row.materialCount === 'number' && Number.isFinite(row.materialCount)) return Math.max(0, Math.floor(row.materialCount));
  const base = row?.baseCardId || row?.cardId;
  if (base && inventory.length) {
    return inventory.reduce((sum, item) => ((item.baseCardId || item.cardId) === base ? sum + enhanceMaterials(item.quantity ?? 0) : sum), 0);
  }
  return enhanceMaterials(row?.quantity ?? 0);
}

/**
 * Position shown next to a card. lib/battle owns the rule (회복→힐러, 보호→탱커, 상태이상→지원, 공격→딜러);
 * when its label table is not published yet, the same four Korean words are used so the screen stays
 * readable. Display only: battle numbers always come from the battle module.
 */
const POSITION_TEXT: Record<string, string> = { healer: '힐러', tank: '탱커', dealer: '딜러', support: '지원' };
const SHARED_POSITION_LABEL = (battleTypes as unknown as { POSITION_LABEL?: Record<string, string> }).POSITION_LABEL;

function opsPosition(ops: readonly AbilityOp[]): string {
  const kinds = new Set<string>();
  const walk = (list: readonly AbilityOp[]) => { for (const op of list) { if (op.op === 'conditional') walk(op.then); else kinds.add(op.op); } };
  walk(ops);
  if (kinds.has('heal')) return 'healer';
  if (kinds.has('shield')) return 'tank';
  if (kinds.has('apply_status') || kinds.has('modify_stat')) return 'support';
  return 'dealer';
}

/** Position + element of one card, derived once from the same lib the battle engine uses. */
export function cardIdentity(card: Card): { position: string; positionLabel: string; element: Element } {
  const stats = battleStats(card) as CardBattleStats & { position?: string };
  const position = stats.position ?? opsPosition(stats.ability.ops);
  return { position, positionLabel: SHARED_POSITION_LABEL?.[position] ?? POSITION_TEXT[position] ?? POSITION_TEXT.dealer!, element: stats.element };
}

/** A card is transcended when it already climbed a rarity or one of its traits did. */
export function isTranscended(rarity: Rarity, traits: readonly Trait[] = []): boolean {
  return rarity === 'XR' || traits.some((trait) => trait.transcended);
}

/** 유효등급 · 초월 · 포지션 · 속성 · +n: the five marks every owned card carries on screen. */
export function CardBadges({ card, progress, className = '' }: { card: Card; progress?: CardProgress; className?: string }) {
  const identity = cardIdentity(card);
  return (
    <div className={`card-badges${className ? ` ${className}` : ''}`}>
      <span className="card-badge">{identity.positionLabel}</span>
      <span className="card-badge">{ELEMENT_LABEL[identity.element]}</span>
      <span className={`card-badge rarity-${card.rarity}`}>{card.rarity}</span>
      {progress && progress.enhanceLevel > 0 && <span className="card-badge is-enhance">+{progress.enhanceLevel}</span>}
      {isTranscended(card.rarity, progress?.traits) && <span className="card-badge is-transcend"><Icon name="sparkle" />초월</span>}
    </div>
  );
}

/**
 * Grid/list preview: plain DOM, no springs, pointer tracking or foil layers. The archive renders
 * one per card, so a per-card spring + two motion layers was the biggest idle cost on the page.
 */
export const StaticCardArtwork = memo(function StaticCardArtwork({ card, quantity = 0, materialCount, enhanceLevel = 0, priority = false, unowned = false }: CardArtworkProps) {
  const thumbKey = card.imageKey ? `${card.imageKey.replace(/\.[^.]+$/, "")}.webp` : "";
  const materials = materialCount ?? enhanceMaterials(quantity);
  return (
    <div className={`card-art rarity-${card.rarity}${unowned ? ' is-unowned' : ''}`}>
      <img src={`/cards/thumbs/${thumbKey}`} alt={cardTitle(card)} loading={priority ? 'eager' : 'lazy'} fetchPriority={priority ? 'high' : undefined} decoding="async" draggable={false} />
      <div className="card-shade" />
      <span className="card-edition">LIMKETMON <span>ORIGINALS</span></span>
      <span className="card-rarity">{card.rarity}<Icon name="sparkle" /></span>
      <div className="card-caption"><span>No. {String(card.version).padStart(3, '0')}</span><strong>{cardTitle(card)}</strong><small>{card.skillName}</small></div>
      {materials > 0 && <span className="card-quantity">재료 {materials}</span>}
      {enhanceLevel > 0 && <span className="card-enhance">+{enhanceLevel}</span>}
      <span className="card-frame" />
    </div>
  );
});

/** Tilt + foil: only the one or two cards the player is actively looking at (detail, pull reveal). */
function InteractiveCardArtwork({ card, quantity = 0, materialCount, enhanceLevel = 0, priority = false, unowned = false }: CardArtworkProps) {
  const reduced = useReducedMotion();
  const materials = materialCount ?? enhanceMaterials(quantity);
  const rx = useSpring(0, gentleSpring);
  const ry = useSpring(0, gentleSpring);
  const light = useSpring(0, { stiffness: 350, damping: 35 });
  const px = useMotionValue(50);
  const py = useMotionValue(50);
  const glare = useMotionTemplate`radial-gradient(ellipse at ${px}% ${py}%, #fff 0%, #ffffff44 24%, transparent 68%)`;
  const position = useMotionTemplate`${px}% ${py}%`;

  function move(event: PointerEvent<HTMLDivElement>) {
    if (reduced) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    rx.set((0.5 - y) * 16);
    ry.set((x - 0.5) * 18);
    px.set(x * 100);
    py.set(y * 100);
    light.set(1);
  }
  function reset() { rx.set(0); ry.set(0); light.set(0); }

  return (
    <motion.div
      className={`card-art rarity-${card.rarity}${unowned ? ' is-unowned' : ''}`}
      style={{ rotateX: rx, rotateY: ry, transformPerspective: 900 }}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); move(event); }} onPointerMove={move} onPointerLeave={reset} onPointerUp={reset} onPointerCancel={reset}
    >
      <img src={`/cards/${card.imageKey}`} alt={cardTitle(card)} loading={priority ? 'eager' : 'lazy'} fetchPriority={priority ? 'high' : undefined} decoding="async" draggable={false} />
      <div className="card-shade" />
      <span className="card-edition">LIMKETMON <span>ORIGINALS</span></span>
      <span className="card-rarity">{card.rarity}<Icon name="sparkle" /></span>
      <div className="card-caption"><span>No. {String(card.version).padStart(3, '0')}</span><strong>{cardTitle(card)}</strong><small>{card.skillName}</small></div>
      {materials > 0 && <span className="card-quantity">재료 {materials}</span>}
      {enhanceLevel > 0 && <span className="card-enhance">+{enhanceLevel}</span>}
      <motion.div className="card-foil" style={{ opacity: light, backgroundPosition: position }} />
      <motion.div className="card-glare" style={{ opacity: light, backgroundImage: glare }} />
      <span className="card-frame" />
    </motion.div>
  );
}

export function CardArtwork({ interactive = false, ...props }: CardArtworkProps & { interactive?: boolean }) {
  return interactive ? <InteractiveCardArtwork {...props} /> : <StaticCardArtwork {...props} />;
}

export function CardButton({ card, quantity = 0, materialCount, enhanceLevel = 0, unowned = false, onClick, priority = false }: { card: Card; quantity?: number; materialCount?: number; enhanceLevel?: number; unowned?: boolean; onClick: () => void; priority?: boolean }) {
  const materials = materialCount ?? enhanceMaterials(quantity);
  return <button type="button" className="card-button" onClick={onClick} aria-label={`${cardTitle(card)}, ${card.rarity}, ${quantity ? `보유 ${quantity}장 · 강화 재료 ${materials}장` : '카드 미리보기'}`}><StaticCardArtwork card={card} quantity={quantity} materialCount={materials} enhanceLevel={enhanceLevel} priority={priority} unowned={unowned} /></button>;
}

export function CardBack({ count = 1 }: { count?: number }) {
  const deck = count >= 10 ? 'TEN CARDS' : count === 5 ? 'FIVE CARDS' : 'ONE CARD';
  return <div className="card-back"><div className="back-top"><span>100% LIM SINGYU</span><span>VOL. 01</span></div><div className="back-center"><Brand /><span>또 너냐, 임신규.</span></div><div className="back-bottom"><span>{deck}<br />열어도 임신규. 또 열어도 임신규.</span><Icon name="sparkle" /></div></div>;
}

/** Battle numbers for the detail sheet. Derived from lib, so the sheet never re-implements rules. */
function BattleCardPanel({ card, enhanceLevel = 0 }: { card: Card; enhanceLevel?: number }) {
  const base = battleStats(card);
  const stats = applyEnhance(base, enhanceLevel, card.rarity);
  const next = enhanceLevel < MAX_ENHANCE ? applyEnhance(base, enhanceLevel + 1, card.rarity) : null;
  // The combatant's real signature: the raw catalog numbers scaled to the card's own stats.
  const signature = scaleAbility(stats.ability, card.rarity, enhanceLevel, catalogCard(card).rarity);
  const rows: Array<[string, string, number]> = [
    ['체력', String(stats.maxHp), stats.maxHp - base.maxHp],
    ['공격', String(stats.atk), stats.atk - base.atk],
    ['방어', String(stats.def), stats.def - base.def],
    ['속도', String(stats.spd), stats.spd - base.spd],
    ['치명타', stats.crit + '%', stats.crit - base.crit],
    ['속성', ELEMENT_LABEL[stats.element], 0]
  ];
  // Shared rarity-aware curve (lib/enhance.ts), so the preview can never drift from the server.
  const gains = next
    ? ([['체력', next.maxHp - stats.maxHp], ['공격', next.atk - stats.atk], ['방어', next.def - stats.def], ['속도', next.spd - stats.spd], ['치명타', next.crit - stats.crit]] as Array<[string, number]>).filter(([, delta]) => delta > 0)
    : [];
  return (
    <div className="battle-card-panel">
      <span className="eyebrow">BATTLE PROFILE{enhanceLevel ? ' · +' + enhanceLevel : ''}</span>
      <dl className="battle-card-stats">
        {rows.map(([label, value, delta]) => (
          <div key={label}><dt>{label}</dt><dd>{value}{delta > 0 ? <span className="stat-delta">+{delta}</span> : null}</dd></div>
        ))}
      </dl>
      <p className="battle-card-skill">
        <Icon name="sparkle" />
        <span>기운 <strong>{stats.cost}</strong> 소모{signature.cooldown > 0 ? ` · 재사용 ${signature.cooldown}턴` : ' · 쿨다운 없음'} · {describeOps(signature.ops)}</span>
      </p>
      <p className="battle-card-next">
        <Icon name="sparkle" />
        <span>{next
          ? <>다음 <strong>+{enhanceLevel + 1}</strong> 강화 시 {gains.length ? gains.map(([label, delta]) => `${label} +${delta}`).join(' · ') : '추가 상승 없음'} <small>등급별 곡선 근사치</small></>
          : '최대 강화 단계입니다.'}</span>
      </p>
      <EnhanceSkillPanel card={card} stats={stats} enhanceLevel={enhanceLevel} />
    </div>
  );
}

/**
 * The card's +5 / +10 / +15 unlocks, ops included, so the sheet never claims an effect the DSL
 * does not have. Locked entries stay visible (name, level, plain-Korean ops) so a player can plan.
 * Every unlocked skill spends the same energy pool and shares the one combatant cooldown counter.
 */
function EnhanceSkillPanel({ card, stats, enhanceLevel }: { card: Card; stats: CardBattleStats; enhanceLevel: number }) {
  const skills = enhanceSkillsForCard(card, stats);
  if (!skills.length) return null;
  const next = skills.find((skill) => skill.level > enhanceLevel);
  return (
    <div className="enhance-skill-panel">
      <span className="eyebrow">해금 기술 · +5 / +10 / +15</span>
      <p className="enhance-skill-intro">강화 단계가 오르면 카드 전용 기술이 열립니다. 모든 기술은 기운과 재사용 대기를 함께 씁니다.</p>
      <ul className="enhance-skill-list">
        {skills.map((skill) => {
          const unlocked = skill.level <= enhanceLevel;
          return (
            <li key={skill.ability.id} data-locked={!unlocked}>
              <div className="enhance-skill-head">
                <strong>{skill.ability.name}</strong>
                <span className="enhance-skill-level">{unlocked ? `강화 +${skill.level} · 사용 가능` : `강화 +${skill.level}에서 해금`}</span>
              </div>
              <p className="enhance-skill-ops"><Icon name="sparkle" />기운 {skill.ability.cost}{skill.ability.cooldown > 0 ? ` · 재사용 ${skill.ability.cooldown}턴` : ''} · {describeOps(skill.ability.ops)}</p>
              <p className="enhance-skill-flavor">{skill.flavor}</p>
            </li>
          );
        })}
      </ul>
      <p className="enhance-skill-next">
        {next
          ? <>다음 <strong>+{next.level}</strong> 강화에서 <strong>{next.ability.name}</strong> 기술이 열립니다.</>
          : '모든 해금 기술을 사용할 수 있습니다.'}
      </p>
    </div>
  );
}

/** One plain-Korean line for what the skill does, taken straight from the ability data. */
export function describeOps(ops: readonly AbilityOp[]): string {
  return ops
    .map((op) => {
      switch (op.op) {
        case 'damage':
          return op.hits && op.hits > 1 ? `피해 ${op.power}×${op.hits}회` : `피해 ${op.power}`;
        case 'heal':
          return `회복 ${op.amount}`;
        case 'shield':
          return `보호막 ${op.amount}`;
        case 'apply_status':
          return STATUS_LABEL[op.status] + (op.turns ? ` ${op.turns}턴` : '');
        case 'modify_stat':
          return `${STATUS_LABEL[op.status]} ${op.value}%`;
        case 'conditional':
          return `조건부(${describeOps(op.then)})`;
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join(' · ');
}

export function CardDetail({ card, quantity, materialCount, enhanceLevel = 0, unowned = false, obtainedAt, progress, growth, onEnhance, enhancing, onClose }: { card: Card; quantity: number; materialCount?: number; enhanceLevel?: number; unowned?: boolean; obtainedAt?: string; progress?: CardProgress; growth?: ReactNode; onEnhance?: (cardId: string) => Promise<void>; enhancing?: boolean; onClose: () => void }) {
  const reduced = useReducedMotion();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const drag = useDragControls();
  const y = useMotionValue(0);
  const dragged = useRef(false);
  const [note, setNote] = useState<string | null>(null);
  const materials = materialCount ?? enhanceMaterials(quantity);
  const cost = enhanceCost(enhanceLevel);
  const deficit = cost - materials;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    const el = dialog.current;
    el?.showModal();
    document.body.style.overflow = 'hidden';
    return () => { el?.close(); document.body.style.overflow = overflow; previous?.focus({ preventScroll: true }); };
  }, []);

  return (
    <motion.dialog ref={dialog} className="detail-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
      <button type="button" className="icon-button detail-back" autoFocus onClick={onClose} aria-label="뒤로가기"><Icon name="back" /></button>
      <motion.section
        className={`detail-sheet rarity-${card.rarity}`} style={{ y }} drag={reduced ? false : 'y'} dragControls={drag} dragListener={false} dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0.05, bottom: 0.6 }} dragTransition={{ bounceStiffness: 360, bounceDamping: 34 }}
        onDragStart={() => { dragged.current = true; }} onDragEnd={(_, info) => { if (info.velocity.y >= 0 && projectedPosition(y.get(), info.velocity.y) > 140) onClose(); else animate(y, 0, { ...spring, velocity: info.velocity.y }); }}
        initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }} transition={spring}
      >
        <button className="sheet-handle" aria-label="아래로 끌어 닫기, 또는 눌러 닫기" onPointerDown={(event) => { dragged.current = false; drag.start(event); }} onClick={(event) => { if (!dragged.current || event.detail === 0) onClose(); }}><span /></button>
        <div className="detail-scroll">
        
        <div className="detail-art"><CardArtwork card={card} quantity={quantity} materialCount={materials} enhanceLevel={enhanceLevel} priority interactive unowned={unowned} /><p><Icon name="hand" />카드에 손을 대고 빛을 움직여 보세요</p></div>
          <div className="detail-copy"><div className="detail-meta"><span className={`rarity-tag rarity-${card.rarity}`}>{card.rarity}</span>{isTranscended(card.rarity, progress?.traits) && <span className="transcend-tag"><Icon name="sparkle" />초월</span>}<span>NO. {String(card.version).padStart(3, '0')} / ORIGINALS</span></div>
          <h2 id={titleId}>{cardTitle(card)}</h2><p className="detail-name">{card.name}</p>
          <CardBadges card={card} progress={progress} className="detail-badges" />
          <div className="skill-block"><span className="eyebrow">SPECIAL ABILITY</span><h3>{card.skillName}</h3><p>{card.skillDescription}</p></div>
          <blockquote>“{card.flavorText}”</blockquote>
          <dl className="card-stats">{[['공격', card.attack], ['방어', card.defense], ['행운', card.luck]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}<span>/ 100</span></dd><div className="stat-track" aria-hidden="true"><motion.i initial={{ scaleX: reduced ? Number(value) / 100 : 0 }} animate={{ scaleX: Number(value) / 100 }} transition={{ ...spring, delay: reduced ? 0 : 0.15 }} /></div></div>)}</dl>
          <BattleCardPanel card={card} enhanceLevel={enhanceLevel} />
          {quantity > 0 && (
            <div className="enhance-panel">
              <span className="eyebrow">ENHANCE</span>
              <p>같은 카드를 소모해 전투 수치를 올립니다. 단계가 오를수록 더 많이 필요하고, 표시 수치는 등급별 곡선에 따른 근사치입니다.</p>
              <p className="enhance-level">본체 1장 · 강화 +{enhanceLevel} / +{MAX_ENHANCE}</p>
              <p>중복 재료 {enhanceMaterials(quantity)}장 · +0 · 특성 없음</p>
              <p>같은 원본 카드에서 쓸 수 있는 강화 재료: {materials}장</p>
              {onEnhance ? (
                <button
                  type="button"
                  className="btn btn-dark"
                  disabled={enhancing || enhanceLevel >= MAX_ENHANCE || materials < cost}
                  onClick={async () => {
                    setNote(null);
                    try {
                      await onEnhance(card.id);
                      setNote('강화했어요.');
                    } catch (error) {
                      setNote(error instanceof Error ? error.message : '강화하지 못했어요.');
                    }
                  }}
                >
                  {enhanceLevel >= MAX_ENHANCE ? '최대 강화' : materials >= cost ? '강화 +' + (enhanceLevel + 1) + ' · 재료 ' + cost + '장 소모' : '강화 재료 ' + materials + '장 / ' + cost + '장 필요 · ' + deficit + '장 부족'}
                </button>
              ) : null}
              {note && <p className="enhance-note">{note}</p>}
            </div>
          )}
          {growth}
          <div className="detail-ownership"><span>{quantity ? <><Icon name="check" />내 컬렉션 · 보유 {quantity}장 · 강화 재료 {materials}장</> : '아직 발견하지 못한 카드'}</span>{obtainedAt && <small>{new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium' }).format(new Date(obtainedAt))} 첫 수집</small>}</div>
        </div>
        </div>
      </motion.section>
    </motion.dialog>
  );
}
