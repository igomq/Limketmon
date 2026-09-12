'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Card } from '../lib/cards';
import type { Ability, AiProfile, BattleEvent, BattleKind, BattleMode, BattleModifier, BattleSetup, BattleState, Combatant, Decision } from '../lib/battle/types';
import { ELEMENT_LABEL, STATUS_LABEL } from '../lib/battle/types';
import type { BattleResultSummary, BattleSetupResponse, DailyChallengeSummary, DeckSummary } from '../lib/battle/api';
import { BATTLE_MODES, MODE_CREDITS_MULTIPLIER, MODE_LABELS, OPPONENTS, opponentById } from '../lib/battle/opponents';
import { extremeRewardOptions } from '../lib/rewards';
import type { TicketType } from '../lib/pull';
import { runBattle, stepBattle } from '../lib/battle/simulate';
import { aiDecision, deciderFor } from '../lib/battle/ai';
import { CardArtwork, CardBadges, Icon, cardIdentity, describeOps, isTranscended, spring } from './card-ui';
import type { InventoryRow } from './progression-ui';
import './battle.css';

type User = { email: string; displayName: string } | null;

type BattleViewProps = {
  user: User;
  decks: DeckSummary[];
  cards: Card[];
  daily: DailyChallengeSummary | null;
  /** Modes the server has unlocked for this user; locked chips show the requirement. */
  unlockedModes: BattleMode[];
  /** Opponent ids already cleared, per mode; drives the completion ticks and progress. */
  clearedByMode: Record<BattleMode, string[]>;
  /** Owned rows: effective card + growth state, so tiles can show +n / 포지션 / 초월. */
  inventory?: InventoryRow[];
  onStateChange: () => void;
  onNavigate: (tab: string) => void;
  onOpenCard: (card: Card) => void;
  onError: (message: string) => void;
};

type FxTone = 'damage' | 'crit' | 'heal' | 'shield' | 'status' | 'down';
type Fx = { key: number; uid: string; text: string; sub: string | null; tone: FxTone };
type LogEntry = { key: number; event: BattleEvent };

const signInHref = `/signin-with-chatgpt?return_to=${encodeURIComponent('/#battle')}`;
const LOG_LIMIT = 80;
const DECK_SIZE = 3;
const DIFFICULTY_LABEL: Record<string, string> = { beginner: '입문', normal: '보통', hard: '하드', boss: '보스' };
const RESULT_LABEL: Record<BattleState['status'], string> = { active: '진행 중', won: '승리', lost: '패배', draw: '무승부' };
/** Shown on a locked mode chip; the requirement mirrors the server unlock rule. */
const MODE_UNLOCK_HINT: Record<BattleMode, string> = { normal: '기본 해제', hard: '일반 5명 격파 시', chaos: '하드 5명 격파 시', extreme: '카오스 5명 격파 시' };
const TICKET_LABEL: Record<TicketType, string> = { low: '하급 뽑기권', normal: '보통 뽑기권', sr: 'SR 이상 뽑기권', ssr: 'SSR 이상 뽑기권' };
/** Mirrors lib/achievements.ts ids; the summary only carries ids. */
const ACHIEVEMENT_LABEL: Record<string, string> = {
  first_win: '첫 승리',
  wins_10: '10승 달성',
  boss_clear: '보스 격파',
  n_only_win: 'N등급의 반란',
  clutch_win: '역전의 순간',
  all_rarities: '모든 등급 수집',
  pulls_100: '100회 뽑기',
  daily_3: '데일리 3회 클리어'
};
const DEFAULT_PROFILE: AiProfile = { healBelow: 0.7, lethalFirst: false, skillMinTargets: 0, skillAppetite: 0.5 };

/**
 * Event playback pace. Purely a presentation preference, never a battle rule: the server still owns
 * the seed and re-simulates every submitted decision. 'instant' drains the pending queue in one
 * batch (and is forced whenever the OS asks for reduced motion).
 */
type BattlePace = 'normal' | 'x2' | 'instant';
const PACE_OPTIONS: Array<{ value: BattlePace; label: string }> = [
  { value: 'normal', label: '기본' },
  { value: 'x2', label: '2배속' },
  { value: 'instant', label: '즉시 진행' }
];
const PACE_SCALE: Record<BattlePace, number> = { normal: 1, x2: 0.5, instant: 0 };

/** The AI profile the server re-simulates with: the same mode-aware lib lookup, never a local guess. */
function profileFor(opponentId: string, mode: BattleMode): AiProfile {
  return opponentById(opponentId, mode)?.profile ?? DEFAULT_PROFILE;
}

function stepDelay(event: BattleEvent, reduced: boolean): number {
  if (reduced) return event.t === 'end' ? 600 : 320;
  if (event.t === 'end') return 1000;
  if (event.t === 'down') return 720;
  if (event.t === 'start') return 620;
  return 520;
}

function modifierLabel(modifier: BattleModifier): string {
  switch (modifier.kind) {
    case 'rarity_cap': return `${modifier.max} 등급 이하 카드만 사용`;
    case 'element_boost': return `${ELEMENT_LABEL[modifier.element]} 속성 피해 +${Math.round(modifier.bonus * 100)}%`;
    case 'turn_limit': return `${modifier.turns}라운드 안에 승리`;
    default: return '추가 규칙 없음';
  }
}

/** Reads one engine event out loud. The log never derives rules, it only reports them. */
function describe(event: BattleEvent, name: (uid: string) => string): { text: string; tone: string } {
  switch (event.t) {
    case 'start': return { text: `${event.round}라운드 시작`, tone: 'round' };
    case 'turn': return { text: `${name(event.uid)}의 차례`, tone: 'turn' };
    case 'action': return { text: `${name(event.uid)} · ${event.abilityName ?? '일반 공격'}`, tone: 'action' };
    case 'damage': {
      const sub: string[] = [];
      if (event.crit) sub.push('치명타');
      if (event.absorbed > 0) sub.push(`보호막 ${event.absorbed} 흡수`);
      if (event.element === 'strong') sub.push('속성 유리');
      if (event.element === 'weak') sub.push('속성 불리');
      if (event.synergy) {
        const extra = Math.max(0, event.amount - Math.round(event.amount / event.synergy.multiplier));
        sub.push(`연계 ${event.synergy.name}`);
        if (extra > 0) sub.push(`추가 ${extra}`);
      }
      return { text: `${name(event.uid)} → ${name(event.target)} ${event.amount} 피해${sub.length ? ` · ${sub.join(' · ')}` : ''}`, tone: event.crit ? 'crit' : 'damage' };
    }
    case 'heal': return { text: `${name(event.uid)} → ${name(event.target)} ${event.amount} 회복`, tone: 'heal' };
    case 'shield': return { text: `${name(event.target)} 보호막 ${event.amount}`, tone: 'shield' };
    case 'status': return { text: `${name(event.target)} ${STATUS_LABEL[event.status]}${event.applied ? ` ${event.turns}턴` : ' 저항'}`, tone: 'status' };
    case 'skip': return { text: `${name(event.uid)} ${event.reason === 'stun' ? '기절로 행동 불가' : '쓰러져 행동 불가'}`, tone: 'skip' };
    case 'down': return { text: `${name(event.uid)} 쓰러짐`, tone: 'down' };
    case 'warn': return { text: event.message, tone: 'warn' };
    case 'end': return { text: `${RESULT_LABEL[event.status]} · ${event.round}라운드`, tone: 'end' };
    default: return { text: '', tone: 'round' };
  }
}

/** The floating number over one tile: one event in, one effect out. */
function effectFor(event: BattleEvent): { uid: string; text: string; sub: string | null; tone: FxTone } | null {
  switch (event.t) {
    case 'damage': {
      const sub: string[] = [];
      if (event.crit) sub.push('치명타');
      if (event.absorbed > 0) sub.push(`보호막 ${event.absorbed} 흡수`);
      if (event.element === 'strong') sub.push('효과가 컸다');
      if (event.element === 'weak') sub.push('효과가 약했다');
      if (event.synergy) {
        const extra = Math.max(0, event.amount - Math.round(event.amount / event.synergy.multiplier));
        sub.push(`연계 ${event.synergy.name}`);
        if (extra > 0) sub.push(`추가 ${extra}`);
      }
      if (event.source === 'poison') sub.push('중독');
      return { uid: event.target, text: `-${event.amount}`, sub: sub.length ? sub.join(' · ') : null, tone: event.crit ? 'crit' : 'damage' };
    }
    case 'heal': return { uid: event.target, text: `+${event.amount}`, sub: event.source === 'regen' ? '회복' : '치유', tone: 'heal' };
    case 'shield': return { uid: event.target, text: `+${event.amount}`, sub: '보호막', tone: 'shield' };
    case 'status': return { uid: event.target, text: STATUS_LABEL[event.status], sub: event.applied ? `${event.turns}턴` : '저항', tone: 'status' };
    case 'skip': return { uid: event.uid, text: event.reason === 'stun' ? '기절' : '행동 불가', sub: null, tone: 'status' };
    case 'down': return { uid: event.uid, text: '쓰러짐', sub: null, tone: 'down' };
    default: return null;
  }
}

/** Every field the tile renders, so memo can compare a string instead of object identity. */
function signature(c: Combatant): string {
  const statuses = c.statuses.map((status) => `${status.id}:${status.turns}:${status.value}`).join('|');
  return `${c.name}|${c.hp}|${c.maxHp}|${c.energy}|${c.cooldown}|${c.element}|${statuses}`;
}

/**
 * Opponent policy. This is lib/battle/ai.ts, the same module the finish route re-simulates with:
 * a different policy here would make the server reject the submitted battle as unverifiable.
 */
export const createOpponentDecider = deciderFor;

/** Exposed for tests: the exact decision the opponent would take in this state. */
export function opponentDecision(state: BattleState, profile: AiProfile): Decision {
  return aiDecision(state, profile);
}

const UnitTile = memo(function UnitTile({ c, card, fx, active, reduced, progress }: {
  c: Combatant;
  sig: string;
  card: Card | undefined;
  fx: Fx | null;
  active: boolean;
  reduced: boolean;
  progress?: InventoryRow;
}) {
  const enhanceLevel = progress?.enhanceLevel ?? 0;
  const ratio = c.maxHp > 0 ? Math.max(0, c.hp) / c.maxHp : 0;
  const health = c.hp <= 0 ? 'down' : ratio <= 0.3 ? 'low' : ratio <= 0.6 ? 'mid' : 'high';
  const frames = reduced
    ? { opacity: [0, 1, 1, 0] }
    : { opacity: [0, 1, 1, 0], y: [4, -12, -24, -32], scale: fx?.tone === 'crit' ? [0.9, 1.3, 1.2, 1.08] : [0.85, 1.06, 1, 0.98] };
  return (
    <article className={`unit-tile rarity-${c.rarity} ${active ? 'is-active' : ''} ${c.hp <= 0 ? 'is-down' : ''}`}>
      <div className="unit-head">
        <span className="unit-element">{ELEMENT_LABEL[c.element]}</span>
        {card && <span className="unit-position">{cardIdentity(card).positionLabel}</span>}
        {enhanceLevel > 0 && <span className="unit-enhance">+{enhanceLevel}</span>}
        {isTranscended(c.rarity, progress?.traits) && <span className="unit-transcend"><Icon name="sparkle" />초월</span>}
        {active && <span className="unit-turn">차례</span>}
      </div>
      <div className="unit-art">
        {card ? <CardArtwork card={card} enhanceLevel={enhanceLevel} /> : <div className="unit-fallback">{c.name}</div>}
      </div>
      <p className="unit-name">{c.name}</p>
      <div className="hp-bar" data-state={health} role="progressbar" aria-label={`${c.name} 체력`} aria-valuenow={c.hp} aria-valuemin={0} aria-valuemax={c.maxHp}>
        <motion.i animate={{ scaleX: ratio }} transition={spring} />
        <span className="hp-text">{c.hp} / {c.maxHp}</span>
      </div>
      {!!c.statuses.length && (
        <ul className="status-chips">
          {c.statuses.map((status, index) => (
            <li key={`${status.id}-${index}`} className="status-chip" data-status={status.id}>
              <span>{STATUS_LABEL[status.id]}</span>
              {status.value > 0 && <b>{status.value}{status.id.endsWith('_up') || status.id.endsWith('_down') ? '%' : ''}</b>}
              <small>{status.turns}턴</small>
            </li>
          ))}
        </ul>
      )}
      {c.side === 'a' && <p className="unit-energy">기운 <strong>{c.energy}</strong>{c.cooldown > 0 && <span>재사용 {c.cooldown}</span>}</p>}
      {fx && (
        <motion.span key={`num-${fx.key}`} className={`fx fx-${fx.tone}`} aria-hidden="true" initial={frames} animate={frames} transition={{ duration: reduced ? 0.6 : 0.9, times: [0, 0.18, 0.7, 1], ease: 'easeOut' }}>
          <strong>{fx.text}</strong>
          {fx.sub && <small>{fx.sub}</small>}
        </motion.span>
      )}
      {fx && <span key={`flash-${fx.key}`} className={`fx-flash fx-${fx.tone}`} aria-hidden="true" />}
    </article>
  );
}, (before, after) => before.sig === after.sig && before.card === after.card && before.active === after.active && before.fx?.key === after.fx?.key && before.reduced === after.reduced && before.progress === after.progress);

export function BattleView({ user, decks, cards, daily, unlockedModes, clearedByMode, inventory, onStateChange, onNavigate, onOpenCard, onError }: BattleViewProps) {
  const reduced = !!useReducedMotion();
  const byId = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  const rows = useMemo(() => new Map(inventory?.map((item) => [item.cardId, item]) ?? []), [inventory]);
  const [phase, setPhase] = useState<'select' | 'battle'>('select');
  useEffect(() => {
    if (phase !== 'battle') return;
    document.documentElement.dataset.battle = 'running';
    return () => { delete document.documentElement.dataset.battle; };
  }, [phase]);
  const [deckId, setDeckId] = useState('');
  const [mode, setMode] = useState<BattleMode>('normal');
  const [rewardChoice, setRewardChoice] = useState<TicketType | null>(null);
  const [starting, setStarting] = useState(false);
  const [setup, setSetup] = useState<BattleSetupResponse | null>(null);
  const extremeOn = mode === 'extreme' || setup?.mode === 'extreme';
  useEffect(() => {
    if (extremeOn) document.documentElement.dataset.extreme = 'true';
    else delete document.documentElement.dataset.extreme;
    return () => { delete document.documentElement.dataset.extreme; };
  }, [extremeOn]);
  const [battleId, setBattleId] = useState<string | null>(null);
  const [state, setState] = useState<BattleState | null>(null);
  const [queue, setQueue] = useState<BattleEvent[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [fx, setFx] = useState<Fx[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [summary, setSummary] = useState<BattleResultSummary | null>(null);
  const [settling, setSettling] = useState(false);
  const [settleFailed, setSettleFailed] = useState(false);
  /** The settlement dialog owns the result; closing it leaves a re-open handle in the arena. */
  const [resultOpen, setResultOpen] = useState(false);
  /** Component-local only: no storage, no server round-trip, no effect on the verified battle. */
  const [pace, setPace] = useState<BattlePace>('x2');
  /** Reduced-motion users always get the instant drain, whatever the select says. */
  const activePace: BattlePace = reduced ? 'instant' : pace;
  const decisions = useRef<Decision[]>([]);
  const consumed = useRef(0);
  const seq = useRef(0);
  const settled = useRef(false);
  /** Bumped on every settle and on every reset, so a stale response can never land on a new battle. */
  const settleRun = useRef(0);
  /** Same idea for start: leaving the screen mid-request must not drop a battle onto the new view. */
  const startRun = useRef(0);
  const logRef = useRef<HTMLOListElement>(null);

  // Unmounting (tab change) invalidates any in-flight settle/start so its response is ignored.
  useEffect(() => () => { settleRun.current += 1; startRun.current += 1; }, []);

  useEffect(() => {
    if (decks.some((deck) => deck.id === deckId)) return;
    setDeckId((decks.find((deck) => deck.isDefault) ?? decks[0])?.id ?? '');
  }, [decks, deckId]);

  // A snapshot that arrives mid-selection must never leave a locked or unknown mode chosen.
  useEffect(() => {
    if (!unlockedModes.includes(mode)) setMode('normal');
  }, [unlockedModes, mode]);

  useEffect(() => {
    if (!queue.length) return;
    // Instant mode: flush every pending event in one commit. Switching the select mid-animation
    // re-runs this effect, whose cleanup clears the outstanding timer, so no event is lost or doubled.
    if (activePace === 'instant') {
      setLog((entries) => [...entries, ...queue.map((event) => ({ key: (seq.current += 1), event }))].slice(-LOG_LIMIT));
      setQueue([]);
      setFx([]);
      return;
    }
    const head = queue[0]!;
    const key = seq.current + 1;
    seq.current = key;
    const timer = setTimeout(() => {
      setLog((entries) => [...entries, { key, event: head }].slice(-LOG_LIMIT));
      setQueue((rest) => rest.slice(1));
      const effect = effectFor(head);
      if (effect) setFx((list) => [{ key, ...effect }, ...list].slice(0, 4));
    }, stepDelay(head, reduced) * PACE_SCALE[activePace]);
    return () => clearTimeout(timer);
  }, [queue, reduced, activePace]);

  useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [log.length]);

  const settle = useCallback(async () => {
    if (!battleId) return;
    // A reset (새 전투) must not let an in-flight settle write into the new screen.
    const run = ++settleRun.current;
    setSettling(true);
    try {
      const response = await fetch('/api/battle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'finish', battleId, decisions: decisions.current, ...(rewardChoice ? { rewardTicketType: rewardChoice } : {}) })
      });
      const payload = await response.json().catch(() => null) as { summary?: unknown; error?: string } | null;
      const result = readSummary(payload);
      if (!response.ok || !result) throw new Error(payload?.error || '전투 기록을 정산하지 못했어요. 잠시 후 다시 시도해주세요.');
      if (run !== settleRun.current) return;
      if (result.result === 'invalid') {
        setSettleFailed(true);
        onError('전투 기록이 맞지 않아 보상을 지급하지 못했어요. 새 전투로 다시 도전해주세요.');
        return;
      }
      setSettleFailed(false);
      setSummary(result);
      onStateChange();
    } catch (error) {
      if (run !== settleRun.current) return;
      setSettleFailed(true);
      onError(error instanceof Error ? error.message : '연결을 확인한 뒤 다시 시도해주세요.');
    } finally {
      if (run === settleRun.current) setSettling(false);
    }
  }, [battleId, onError, onStateChange, rewardChoice]);

  useEffect(() => {
    if (phase !== 'battle' || !state || state.status === 'active' || settled.current) return;
    if (state.status === 'won' && setup?.mode === 'extreme' && !rewardChoice) {
      setResultOpen(true);
      return;
    }
    settled.current = true;
    setResultOpen(true);
    void settle();
  }, [phase, state, settle, setup?.mode, rewardChoice]);

  const chosen = decks.find((deck) => deck.id === deckId) ?? null;
  const chosenLegal = !!chosen && chosen.cards.length === DECK_SIZE;
  const chosenCards = useMemo(
    () => (chosen?.cards ?? []).reduce<Card[]>((list, id) => { const card = byId.get(id); if (card) list.push(card); return list; }, []),
    [chosen, byId]
  );

  async function start(opponentId: string, kind: BattleKind, battleMode: BattleMode) {
    if (starting || !chosenLegal) return;
    const run = ++startRun.current;
    setStarting(true);
    setNotice(null);
    try {
      const response = await fetch('/api/battle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start', opponentId, deckId, kind, mode: battleMode })
      });
      const body = await response.json() as { setup?: Partial<BattleSetupResponse>; error?: string };
      const data = body.setup;
      if (!response.ok || !data?.battleId || !data.player?.length || !data.opponent?.length || typeof data.seed !== 'number' || typeof data.opponentId !== 'string') {
        throw new Error(body.error || '전투를 시작하지 못했어요. 잠시 후 다시 시도해주세요.');
      }
      const loaded = data as BattleSetupResponse;
      const profile = profileFor(loaded.opponentId, loaded.mode ?? battleMode);
      const opening = runBattle(loaded as BattleSetup, [], createOpponentDecider(profile));
      if (opening.error && opening.error !== 'unfinished') throw new Error('전투를 준비하지 못했어요. 다시 시도해주세요.');
      if (run !== startRun.current) return;
      decisions.current = [];
      consumed.current = opening.events.length;
      settled.current = false;
      setSetup(loaded);
      setBattleId(loaded.battleId);
      setState(opening.state);
      setLog([]);
      setFx([]);
      setQueue(opening.events);
      setSummary(null);
      setSettleFailed(false);
      setResultOpen(false);
      setRewardChoice(null);
      setPhase('battle');
    } catch (error) {
      if (run !== startRun.current) return;
      onError(error instanceof Error ? error.message : '연결을 확인한 뒤 다시 시도해주세요.');
    } finally {
      if (run === startRun.current) setStarting(false);
    }
  }

  function act(action: 'attack' | 'skill', skillId?: string) {
    if (!setup || !state || !state.activeUid || state.status !== 'active' || queue.length) return;
    const uid = state.activeUid;
    // The base signature is sent without an id; an unlocked skill carries its own id so the
    // server re-simulation replays exactly the ability the player saw in the button.
    const decision: Decision = skillId ? { uid, action, skillId } : { uid, action };
    const profile = profileFor(setup.opponentId, setup.mode ?? 'normal');
    const result = stepBattle(state, decision, createOpponentDecider(profile));
    if (result.error) {
      setNotice(
        result.error === 'energy' ? '기운이 부족해요.'
        : result.error === 'cooldown' ? '스킬 재사용 대기 중이에요.'
        : result.error === 'skill' ? '아직 해금하지 못한 스킬이에요.'
        : '지금은 그 행동을 할 수 없어요.'
      );
      return;
    }
    decisions.current.push(decision);
    consumed.current = result.state.log.length;
    setNotice(null);
    setState(result.state);
    setQueue((pending) => [...pending, ...result.events]);
  }

  function reset() {
    settleRun.current += 1;
    startRun.current += 1;
    decisions.current = [];
    consumed.current = 0;
    settled.current = false;
    setPhase('select');
    setSetup(null);
    setBattleId(null);
    setState(null);
    setQueue([]);
    setLog([]);
    setFx([]);
    setSummary(null);
    setSettleFailed(false);
    setResultOpen(false);
    setNotice(null);
  }

  const names = useMemo(() => {
    const map = new Map<string, string>();
    if (state) for (const combatant of [...state.sides.a, ...state.sides.b]) map.set(combatant.uid, combatant.name);
    return map;
  }, [state]);

  if (!user) {
    return (
      <section className="battle-view" aria-labelledby="battle-title">
        <header className="section-head">
          <div>
            <p className="eyebrow">BATTLE</p>
            <h1 id="battle-title">대련.</h1>
            <p>카드 3장으로 겨루는 턴제 전투입니다.</p>
          </div>
        </header>
        <section className="welcome-strip">
          <span><Icon name="sparkle" /><strong>대련은 로그인 후에.</strong><span>덱을 만들면 바로 겨룰 수 있어요.</span></span>
          <a href={signInHref}>ChatGPT로 시작하기<Icon name="arrow" /></a>
        </section>
      </section>
    );
  }

  if (phase === 'select' || !state) {
    return (
      <section className="battle-view" aria-labelledby="battle-title">
        <header className="section-head">
          <div>
            <p className="eyebrow">BATTLE</p>
            <h1 id="battle-title">대련 상대 고르기.</h1>
            <p>카드 3장이 한 덱. 상대마다 난이도와 보상이 다릅니다.</p>
          </div>
        </header>

        <section className="mode-picker" aria-labelledby="mode-title">
          <div className="opponent-heading">
            <h2 id="mode-title">난이도 모드</h2>
            <p className="deck-hint" role="status"><Icon name={(clearedByMode[mode]?.length ?? 0) >= OPPONENTS.length ? 'check' : 'sparkle'} />{MODE_LABELS[mode]} 모드 · {clearedByMode[mode]?.length ?? 0} / {OPPONENTS.length} 격파</p>
          </div>
          <div className="mode-selector" role="group" aria-label="난이도 모드 선택">
            {BATTLE_MODES.filter((item) => item === 'normal' || item === 'hard' || unlockedModes.includes(item)).map((item) => {
              const unlocked = unlockedModes.includes(item);
              const cleared = clearedByMode[item]?.length ?? 0;
              return <button key={item} className="mode-chip" data-mode={item} aria-pressed={mode === item} disabled={!unlocked || starting} onClick={() => setMode(item)}>
                <strong>{MODE_LABELS[item]}</strong>
                <small>{unlocked ? `격파 ${cleared} / ${OPPONENTS.length}` : MODE_UNLOCK_HINT[item]}</small>
                {unlocked && cleared >= OPPONENTS.length && <Icon name="check" />}
              </button>;
            })}
          </div>
          <p className="mode-note">{mode === 'normal'
            ? '기본 난이도입니다. 여기서 상대를 모두 격파하면 상위 모드가 열려요.'
            : mode === 'extreme'
              ? '익스트림은 상대가 성장한 카드로 나오고, 승리 보상 뽑기권 종류를 고를 수 있습니다.'
              : `${MODE_LABELS[mode]} 모드는 상대가 더 강하고 첫 격파 보상이 ${MODE_CREDITS_MULTIPLIER[mode]}배입니다.`}</p>
        </section>

        {chosenLegal ? (
          <section className="battle-deck" aria-labelledby="battle-deck-title">
            <div className="battle-deck-head">
              <h2 id="battle-deck-title">출전 덱</h2>
              <button className="text-button" onClick={() => onNavigate('deck')}>덱 편집<Icon name="arrow" /></button>
            </div>
            <div className="deck-picker" role="group" aria-label="출전 덱 선택">
              {decks.map((deck) => (
                <button key={deck.id} className="deck-chip" aria-pressed={deck.id === deckId} disabled={deck.cards.length !== DECK_SIZE} onClick={() => setDeckId(deck.id)}>
                  <strong>{deck.name}</strong>
                  <small>{deck.isDefault ? '기본 덱 · ' : ''}카드 {deck.cards.length}장</small>
                </button>
              ))}
            </div>
            <ul className="deck-preview">
              {chosenCards.map((card) => {
                const row = rows.get(card.id);
                const level = row?.enhanceLevel ?? 0;
                return (
                  <li key={card.id}>
                    <CardArtwork card={card} enhanceLevel={level} />
                    <span>{card.name}{level > 0 ? ` +${level}` : ''}</span>
                    <CardBadges card={card} progress={row} />
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (
          <section className="empty-state">
            <Icon name="pack" />
            <h2>{decks.length ? '카드 3장을 채운 덱이 필요해요.' : '먼저 전투 덱을 만들어 주세요.'}</h2>
            <p>{decks.length ? '덱 편집에서 카드를 정확히 3장 골라주세요.' : '보유한 카드 3장이 한 덱이 됩니다.'}</p>
            <button className="btn btn-dark" onClick={() => onNavigate('deck')}>덱 만들기<Icon name="arrow" /></button>
          </section>
        )}

        <section className="opponent-section" aria-labelledby="opponent-title">
          <div className="opponent-heading">
            <h2 id="opponent-title">상대</h2>
            {!chosenLegal && <p className="deck-hint" role="status"><Icon name="clock" />출전할 덱을 먼저 정해주세요.</p>}
          </div>
          {daily && (daily.cleared ? (
            <p className="daily-done"><Icon name="check" />오늘의 도전은 완료했어요. 내일 새 규칙으로 다시 열립니다.</p>
          ) : (
            <article className="opponent-card is-daily">
              <header>
                <div>
                  <p className="eyebrow">DAILY CHALLENGE</p>
                  <h3>{daily.title}</h3>
                </div>
                <span className="difficulty">{daily.ruleLabel}</span>
              </header>
              <p className="opponent-blurb">{daily.description}</p>
              <p className="opponent-reward"><Icon name="ticket" />첫 클리어 보상 {daily.rewardCredits}장 · 상대 {daily.opponentName}</p>
              <button className="btn btn-primary" disabled={!chosenLegal || starting} onClick={() => void start(daily.opponentId, 'daily', 'normal')}>
                이 덱으로 전투<Icon name="arrow" />
              </button>
            </article>
          ))}
          <ul className="opponent-grid">
            {OPPONENTS.map((base) => {
              // Mode changes the opponent's team, AI profile and first-clear reward; read them
              // from the same lib lookup the server uses so the card cannot misstate the fight.
              const opponent = opponentById(base.id, mode) ?? base;
              const cleared = clearedByMode[mode]?.includes(base.id) ?? false;
              return (
                <li key={base.id}>
                  <article className="opponent-card">
                    <header>
                      <div>
                        <h3>{opponent.name}{cleared && <span className="clear-badge"><Icon name="check" />격파</span>}</h3>
                        <p className="opponent-title">{opponent.title}</p>
                      </div>
                      <span className="difficulty">{DIFFICULTY_LABEL[opponent.difficulty] ?? opponent.difficulty}</span>
                    </header>
                    <p className="opponent-blurb">{opponent.blurb}</p>
                    <p className="opponent-reward"><Icon name="ticket" />{mode === 'extreme' ? (cleared ? '첫 보상 수령 완료 · 승리 시 뽑기권 종류 선택' : '승리 시 하급·일반·SR+·SSR+ 중 하나 선택') : cleared ? '첫 보상 수령 완료 · 승리 시 확정 지급' : `${opponent.reward.label} ${opponent.reward.credits}장 · 승리 시 확정 지급`}</p>
                    <button className="btn btn-dark" disabled={!chosenLegal || starting} onClick={() => void start(opponent.id, 'pve', mode)}>
                      이 덱으로 전투<Icon name="arrow" />
                    </button>
                  </article>
                </li>
              );
            })}
          </ul>
        </section>
      </section>
    );
  }

  const activeUid = state.activeUid;
  const active = activeUid ? [...state.sides.a, ...state.sides.b].find((combatant) => combatant.uid === activeUid) ?? null : null;
  const myTurn = state.status === 'active' && !!active && state.sides.a.some((combatant) => combatant.uid === active.uid);
  const animating = queue.length > 0;
  /** The server's verdict wins once it arrives; until then the local simulation is the preview. */
  const serverResult = summary?.result;
  const outcome: string =
    serverResult === 'won' || serverResult === 'lost' || serverResult === 'draw' || serverResult === 'invalid'
      ? serverResult
      : state.status;
  const resultHeadline = outcome === 'won' ? '승리했습니다.' : outcome === 'lost' ? '패배했습니다.' : outcome === 'invalid' ? '기록을 확인할 수 없어요.' : '무승부입니다.';
  const canAct = myTurn && !animating;
  const ability = active?.ability ?? null;
  /** Unlocked enhancement skills, in +5 / +10 / +15 order. Empty for opponents and low enhance. */
  const unlockedSkills = active?.skills ?? [];
  const cooldownLeft = active?.cooldown ?? 0;
  const energy = active?.energy ?? 0;
  /** Energy and cooldown are ONE pool per combatant: every skill button reads the same two values. */
  const readyToUse = (skill: Ability) => canAct && cooldownLeft === 0 && energy >= skill.cost;
  const blockedReason = (skill: Ability): string | null => {
    if (!myTurn) return '상대 차례예요.';
    if (animating) return '연출 중이에요.';
    if (cooldownLeft > 0) return `공용 재사용 ${cooldownLeft}턴 남음`;
    if (energy < skill.cost) return `기운 ${skill.cost} 필요 · 현재 ${energy}`;
    return null;
  };
  const skillReady = canAct && cooldownLeft === 0 && !!ability && energy >= ability.cost;
  const anySkillReady = skillReady || (canAct && cooldownLeft === 0 && unlockedSkills.some((skill) => energy >= skill.cost));
  const actionHint = state.status !== 'active'
    ? null
    : animating ? '방금 일어난 일을 보여주는 중이에요.'
    : !myTurn ? `${active?.name ?? '상대'}의 차례를 기다리는 중이에요.`
    : cooldownLeft > 0 ? `스킬은 공용 재사용 ${cooldownLeft}턴 뒤에 다시 쓸 수 있어요.`
    : !anySkillReady ? `스킬에 쓸 기운이 모자라요. 지금 기운은 ${energy}.`
    : '내 차례예요. 행동을 골라주세요.';
  const fxFor = (uid: string) => fx.find((item) => item.uid === uid) ?? null;

  return (
    <section className="battle-view" aria-labelledby="battle-arena-title">
      <div className="battle-stage">
        <header className="battle-head">
          <button className="text-button" onClick={reset}><Icon name="back" />대련 나가기</button>
          <div>
            <p className="eyebrow">{state.kind === 'daily' ? 'DAILY CHALLENGE' : `PVE BATTLE · ${MODE_LABELS[setup?.mode ?? 'normal']}`}</p>
            <h1 id="battle-arena-title">{setup?.opponentName ?? '대련'}</h1>
            <p className="battle-rule"><Icon name="sparkle" />{modifierLabel(state.modifier)}</p>
          </div>
          <div className="battle-round">
            <span className="meta-label">라운드</span>
            <strong>{state.round}</strong>
            <small>상대 {state.sides.b.filter((combatant) => combatant.hp > 0).length} / {state.sides.b.length} 남음</small>
            <label className="battle-pace">
              <span className="meta-label">전투 연출</span>
              <select
                value={activePace}
                disabled={reduced}
                title={reduced ? '동작 줄이기 설정에서는 즉시 진행으로 표시됩니다.' : '전투 기록의 재생 속도만 바꿉니다. 전투 규칙은 그대로입니다.'}
                onChange={(event) => setPace(event.target.value as BattlePace)}
              >
                {PACE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          </div>
        </header>

        <div className="battle-rows">
          <div className="battle-row enemy" role="group" aria-label="상대 팀">
            {state.sides.b.map((combatant) => (
              <UnitTile key={combatant.uid} c={combatant} sig={signature(combatant)} card={byId.get(combatant.cardId)} fx={fxFor(combatant.uid)} active={activeUid === combatant.uid} reduced={reduced} />
            ))}
          </div>
          <div className="battle-status">
            <p className="turn-banner" aria-live="polite">
              {state.status === 'active' ? (myTurn ? '내 차례' : `${active?.name ?? '상대'}의 차례`) : RESULT_LABEL[state.status]}
            </p>
            <p className="battle-energy">
              {active ? `${active.name} · 기운 ${active.energy}${active.cooldown > 0 ? ` · 스킬 재사용 ${active.cooldown}턴` : ''}` : '전투가 끝났어요.'}
            </p>
          </div>
          <div className="battle-row ally" role="group" aria-label="내 팀">
            {state.sides.a.map((combatant) => (
              <UnitTile key={combatant.uid} c={combatant} sig={signature(combatant)} card={byId.get(combatant.cardId)} fx={fxFor(combatant.uid)} active={activeUid === combatant.uid} reduced={reduced} progress={rows.get(combatant.cardId)} />
            ))}
          </div>
          {state.status !== 'active' && (
            <motion.p className="result-banner" data-result={state.status} initial={{ opacity: 0, scale: reduced ? 1 : 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={spring} aria-live="polite">
              {state.status === 'won' ? '승리' : state.status === 'lost' ? '패배' : '무승부'}
            </motion.p>
          )}
        </div>

        <div className="battle-side">
          <h2 className="log-title">전투 기록</h2>
          <ol className="battle-log" role="log" aria-label="전투 기록" ref={logRef}>
            {log.map((entry) => {
              const line = describe(entry.event, (uid) => names.get(uid) ?? '전투원');
              return <li key={entry.key} data-tone={line.tone}>{line.text}</li>;
            })}
          </ol>
        </div>

        {state.status === 'active' ? (
          <div className={`battle-actions sticky-bar${unlockedSkills.length ? ' is-compact' : ''}`}>
            <div className="skill-casts" role="group" aria-label="전투 행동" tabIndex={0}>
            <button className="battle-action" disabled={!canAct} onClick={() => act('attack')}>
              <Icon name="hand" />
              <span>
                <strong>일반 공격</strong>
                <small>기운 소모 없음</small>
              </span>
            </button>
            {ability && (
              <button className="battle-action is-skill" disabled={!readyToUse(ability)} onClick={() => act('skill')}>
                <Icon name="sparkle" />
                <span>
                  <strong>{ability.name}</strong>
                  <small>기운 {ability.cost}{ability.cooldown > 0 ? ` · ${ability.cooldown}턴 대기` : ''} · 기본 기술</small>
                  {!unlockedSkills.length && <em>{describeOps(ability.ops)}</em>}
                  {blockedReason(ability) && <i className="skill-block">{blockedReason(ability)}</i>}
                </span>
              </button>
            )}
            {unlockedSkills.map((skill) => (
              <button key={skill.id} className="battle-action is-skill is-unlocked" disabled={!readyToUse(skill)} onClick={() => act('skill', skill.id)}>
                <Icon name="sparkle" />
                <span>
                  <strong>{skill.name}</strong>
                  <small>기운 {skill.cost}{skill.cooldown > 0 ? ` · ${skill.cooldown}턴 대기` : ''} · 해금 기술</small>
                  <em>{describeOps(skill.ops)}</em>
                  {blockedReason(skill) && <i className="skill-block">{blockedReason(skill)}</i>}
                </span>
              </button>
            ))}
            </div>
            <p className="action-hint" role="status">
              <Icon name={animating || !myTurn ? 'clock' : anySkillReady ? 'check' : 'sparkle'} />
              {notice ?? actionHint}
            </p>
          </div>
        ) : (
          <div className="battle-actions result-panel">
            <div className="result-copy">
              <h2>{resultHeadline}</h2>
              <p>{state.round}라운드{state.endReason === 'turn_limit' ? ' · 라운드 제한' : state.endReason === 'timeout' ? ' · 시간 초과' : ''}</p>
            </div>
            {settling && <p className="result-pending" role="status"><span className="loading-dot" />전투 기록을 정산하는 중이에요.</p>}
            {settleFailed && !settling && (
              <div className="result-pending" role="alert">
                <p>보상 정산을 마치지 못했어요.</p>
                <button className="btn btn-dark" onClick={() => void settle()}>다시 확인하기</button>
              </div>
            )}
            {summary && (
              <div className="result-summary">
                <SummaryBody summary={summary} byId={byId} />
              </div>
            )}
            {state.status === 'won' && setup?.mode === 'extreme' && !summary && (
              <ExtremeRewardPicker opponentId={setup.opponentId} value={rewardChoice} disabled={settling} onPick={setRewardChoice} />
            )}
            <div className="result-actions">
              <button className="btn btn-primary" onClick={() => setResultOpen(true)}>정산 결과 열기<Icon name="arrow" /></button>
              <button className="text-button" onClick={() => onNavigate('deck')}>덱 정리</button>
            </div>
          </div>
        )}

        <AnimatePresence>
          {state.status !== 'active' && resultOpen && (
            <ResultDialog
              key="battle-result"
              outcome={outcome}
              round={state.round}
              endReason={state.endReason}
              summary={summary}
              settling={settling}
              settleFailed={settleFailed}
              byId={byId}
              onRetry={() => void settle()}
              onExit={() => { setResultOpen(false); reset(); }}
              onRematch={() => { setResultOpen(false); if (setup) void start(setup.opponentId, state.kind, setup.mode ?? 'normal'); }}
              onNavigate={onNavigate}
              onClose={() => setResultOpen(false)}
              rewardPicker={state.status === 'won' && setup?.mode === 'extreme' && !summary ? (
                <ExtremeRewardPicker opponentId={setup.opponentId} value={rewardChoice} disabled={settling} onPick={setRewardChoice} />
              ) : null}
            />
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

function ExtremeRewardPicker({ opponentId, value, disabled, onPick }: {
  opponentId: string;
  value: TicketType | null;
  disabled: boolean;
  onPick: (type: TicketType) => void;
}) {
  const options = extremeRewardOptions(opponentId);
  if (!options) return null;
  return <div className="extreme-rewards" role="group" aria-label="승리 보상 선택">
    <p>받을 뽑기권 종류를 고르세요. 한 가지만 지급됩니다.</p>
    <div className="mode-selector">
      {(['low', 'normal', 'sr', 'ssr'] as const).map((type) => (
        <button key={type} type="button" className="mode-chip" data-mode="extreme" aria-pressed={value === type} disabled={disabled} onClick={() => onPick(type)}>
          <strong>{TICKET_LABEL[type]}</strong>
          <small>{options[type]}장</small>
        </button>
      ))}
    </div>
  </div>;
}

/** Reward receipt, achievements and battle numbers: one body for the arena panel and the result sheet. */
function SummaryBody({ summary, byId }: { summary: BattleResultSummary; byId: Map<string, Card> }) {
  return (
    <>
      {summary.rewards.length ? (
        <ul className="reward-list">
          {summary.rewards.map((reward) => (
            <li key={reward.label}><Icon name="ticket" /><span>{reward.label}</span><strong>{reward.ticketType ? `+${reward.quantity ?? 0}장` : `+${reward.credits}장`}</strong></li>
          ))}
        </ul>
      ) : <p className="deck-note">이번 전투에서 지급된 보상은 없어요.</p>}
      {summary.unlocked.length ? (
        <div className="result-unlocked">
          <h3>새로 얻은 업적</h3>
          <ul>{summary.unlocked.map((id) => <li key={id}><span className="text-button">{ACHIEVEMENT_LABEL[id] ?? id}</span></li>)}</ul>
        </div>
      ) : null}
      <dl className="result-stats">
        {summary.mvpCardId && byId.get(summary.mvpCardId) && <div><dt>최고 활약</dt><dd>{byId.get(summary.mvpCardId)?.name}</dd></div>}
        <div><dt>라운드</dt><dd>{summary.rounds}</dd></div>
        <div><dt>가한 피해</dt><dd>{summary.damageDealt}</dd></div>
      </dl>
    </>
  );
}

/**
 * Settlement result sheet. Native dialog: Escape and the backdrop dismiss it without leaving the
 * battle, and the arena keeps a re-open handle. A failed settle keeps its retry in here.
 */
function ResultDialog({ outcome, round, endReason, summary, settling, settleFailed, byId, onRetry, onExit, onRematch, onNavigate, onClose, rewardPicker }: {
  outcome: string;
  round: number;
  endReason?: 'hp' | 'turn_limit' | 'timeout';
  summary: BattleResultSummary | null;
  settling: boolean;
  settleFailed: boolean;
  byId: Map<string, Card>;
  onRetry: () => void;
  onExit: () => void;
  onRematch: () => void;
  onNavigate: (tab: string) => void;
  onClose: () => void;
  rewardPicker?: ReactNode;
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

  const headline = outcome === 'won' ? '승리했습니다.' : outcome === 'lost' ? '패배했습니다.' : outcome === 'invalid' ? '기록을 확인할 수 없어요.' : '무승부입니다.';
  return (
    <motion.dialog
      ref={dialog}
      className="detail-dialog result-dialog"
      aria-labelledby="battle-result-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      <motion.section
        className="detail-sheet result-sheet"
        data-result={outcome}
        initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
        transition={spring}
      >
        <div className="result-sheet-body">
          <header className="result-hero">
            <button type="button" className="icon-button result-close" autoFocus onClick={onClose} aria-label="결과 창 닫기"><Icon name="close" /></button>
            <p className="eyebrow">BATTLE RESULT</p>
            <h2 id="battle-result-title">{headline}</h2>
            <p>{round}라운드{endReason === 'turn_limit' ? ' · 라운드 제한' : endReason === 'timeout' ? ' · 시간 초과' : ''}</p>
          </header>
          {settling && <p className="result-pending" role="status"><span className="loading-dot" />전투 기록을 정산하는 중이에요.</p>}
          {settleFailed && !settling && (
            <div className="result-pending" role="alert">
              <p>보상 정산을 마치지 못했어요. 연결을 확인한 뒤 다시 시도해주세요.</p>
              <button className="btn btn-dark" onClick={onRetry}>다시 확인하기</button>
            </div>
          )}
          {rewardPicker}
          {summary && (
            <div className="result-summary">
              <h3 className="result-receipt"><Icon name="ticket" />지급 내역</h3>
              <SummaryBody summary={summary} byId={byId} />
            </div>
          )}
          <div className="result-actions">
            <button className="btn btn-primary" onClick={onExit}>나가기<Icon name="arrow" /></button>
            <button className="btn btn-dark" disabled={settling} onClick={onRematch}>다시 전투</button>
            <button className="text-button" onClick={() => onNavigate('deck')}>덱 정리</button>
            <button className="text-button" onClick={() => onNavigate('pull')}>카드 더 모으기</button>
          </div>
        </div>
      </motion.section>
    </motion.dialog>
  );
}

/** The finish route answers { summary }; tolerate the summary itself as well. */
function readSummary(payload: unknown): BattleResultSummary | null {
  if (!payload || typeof payload !== 'object') return null;
  const direct = payload as Partial<BattleResultSummary>;
  if (Array.isArray(direct.rewards)) return direct as BattleResultSummary;
  const wrapped = (payload as { summary?: unknown }).summary;
  if (wrapped && typeof wrapped === 'object' && Array.isArray((wrapped as Partial<BattleResultSummary>).rewards)) {
    return wrapped as BattleResultSummary;
  }
  return null;
}
