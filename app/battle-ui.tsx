'use client';

import { motion, useReducedMotion } from 'motion/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Card } from '../lib/cards';
import type { AiProfile, BattleEvent, BattleKind, BattleModifier, BattleSetup, BattleState, Combatant, Decision } from '../lib/battle/types';
import { ELEMENT_LABEL, STATUS_LABEL } from '../lib/battle/types';
import type { BattleResultSummary, BattleSetupResponse, DailyChallengeSummary, DeckSummary } from '../lib/battle/api';
import { OPPONENTS } from '../lib/battle/opponents';
import { runBattle } from '../lib/battle/simulate';
import { aiDecision, deciderFor } from '../lib/battle/ai';
import { CardArtwork, Icon, spring } from './card-ui';
import './battle.css';

type User = { email: string; displayName: string } | null;

type BattleViewProps = {
  user: User;
  decks: DeckSummary[];
  cards: Card[];
  daily: DailyChallengeSummary | null;
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
const DIFFICULTY_LABEL: Record<string, string> = { beginner: '입문', normal: '보통', hard: '고급', boss: '보스' };
const RESULT_LABEL: Record<BattleState['status'], string> = { active: '진행 중', won: '승리', lost: '패배', draw: '무승부' };
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

const UnitTile = memo(function UnitTile({ c, card, fx, active, reduced }: {
  c: Combatant;
  sig: string;
  card: Card | undefined;
  fx: Fx | null;
  active: boolean;
  reduced: boolean;
}) {
  const ratio = c.maxHp > 0 ? Math.max(0, c.hp) / c.maxHp : 0;
  const health = c.hp <= 0 ? 'down' : ratio <= 0.3 ? 'low' : ratio <= 0.6 ? 'mid' : 'high';
  const frames = reduced
    ? { opacity: [0, 1, 1, 0] }
    : { opacity: [0, 1, 1, 0], y: [4, -12, -24, -32], scale: fx?.tone === 'crit' ? [0.9, 1.3, 1.2, 1.08] : [0.85, 1.06, 1, 0.98] };
  return (
    <article className={`unit-tile rarity-${c.rarity} ${active ? 'is-active' : ''} ${c.hp <= 0 ? 'is-down' : ''}`}>
      <div className="unit-head">
        <span className="unit-element">{ELEMENT_LABEL[c.element]}</span>
        {active && <span className="unit-turn">차례</span>}
      </div>
      <div className="unit-art">
        {card ? <CardArtwork card={card} /> : <div className="unit-fallback">{c.name}</div>}
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
}, (before, after) => before.sig === after.sig && before.card === after.card && before.active === after.active && before.fx?.key === after.fx?.key && before.reduced === after.reduced);

export function BattleView({ user, decks, cards, daily, onStateChange, onNavigate, onOpenCard, onError }: BattleViewProps) {
  const reduced = !!useReducedMotion();
  const byId = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  const [phase, setPhase] = useState<'select' | 'battle'>('select');
  const [deckId, setDeckId] = useState('');
  const [starting, setStarting] = useState(false);
  const [setup, setSetup] = useState<BattleSetupResponse | null>(null);
  const [battleId, setBattleId] = useState<string | null>(null);
  const [state, setState] = useState<BattleState | null>(null);
  const [queue, setQueue] = useState<BattleEvent[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [fx, setFx] = useState<Fx[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [summary, setSummary] = useState<BattleResultSummary | null>(null);
  const [settling, setSettling] = useState(false);
  const [settleFailed, setSettleFailed] = useState(false);
  const decisions = useRef<Decision[]>([]);
  const consumed = useRef(0);
  const seq = useRef(0);
  const settled = useRef(false);
  /** Bumped on every settle and on every reset, so a stale response can never land on a new battle. */
  const settleRun = useRef(0);
  const logRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (decks.some((deck) => deck.id === deckId)) return;
    setDeckId((decks.find((deck) => deck.isDefault) ?? decks[0])?.id ?? '');
  }, [decks, deckId]);

  useEffect(() => {
    if (!queue.length) return;
    const head = queue[0]!;
    const key = seq.current + 1;
    seq.current = key;
    const timer = setTimeout(() => {
      setLog((entries) => [...entries, { key, event: head }].slice(-LOG_LIMIT));
      setQueue((rest) => rest.slice(1));
      const effect = effectFor(head);
      if (effect) setFx((list) => [{ key, ...effect }, ...list].slice(0, 4));
    }, stepDelay(head, reduced));
    return () => clearTimeout(timer);
  }, [queue, reduced]);

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
        body: JSON.stringify({ action: 'finish', battleId, decisions: decisions.current })
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
      setSummary(result);
      onStateChange();
    } catch (error) {
      if (run !== settleRun.current) return;
      setSettleFailed(true);
      onError(error instanceof Error ? error.message : '연결을 확인한 뒤 다시 시도해주세요.');
    } finally {
      if (run === settleRun.current) setSettling(false);
    }
  }, [battleId, onError, onStateChange]);

  useEffect(() => {
    if (phase !== 'battle' || !state || state.status === 'active' || settled.current) return;
    settled.current = true;
    void settle();
  }, [phase, state, settle]);

  const chosen = decks.find((deck) => deck.id === deckId) ?? null;
  const chosenLegal = !!chosen && chosen.cards.length === DECK_SIZE;
  const chosenCards = useMemo(
    () => (chosen?.cards ?? []).reduce<Card[]>((list, id) => { const card = byId.get(id); if (card) list.push(card); return list; }, []),
    [chosen, byId]
  );

  async function start(opponentId: string, kind: BattleKind) {
    if (starting || !chosenLegal) return;
    setStarting(true);
    setNotice(null);
    try {
      const response = await fetch('/api/battle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start', opponentId, deckId, kind })
      });
      const body = await response.json() as { setup?: Partial<BattleSetupResponse>; error?: string };
      const data = body.setup;
      if (!response.ok || !data?.battleId || !data.player?.length || !data.opponent?.length || typeof data.seed !== 'number' || typeof data.opponentId !== 'string') {
        throw new Error(body.error || '전투를 시작하지 못했어요. 잠시 후 다시 시도해주세요.');
      }
      const loaded = data as BattleSetupResponse;
      const profile = OPPONENTS.find((opponent) => opponent.id === loaded.opponentId)?.profile ?? DEFAULT_PROFILE;
      const opening = runBattle(loaded as BattleSetup, [], createOpponentDecider(profile));
      if (opening.error && opening.error !== 'unfinished') throw new Error('전투를 준비하지 못했어요. 다시 시도해주세요.');
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
      setPhase('battle');
    } catch (error) {
      onError(error instanceof Error ? error.message : '연결을 확인한 뒤 다시 시도해주세요.');
    } finally {
      setStarting(false);
    }
  }

  function act(action: 'attack' | 'skill') {
    if (!setup || !state || !state.activeUid || state.status !== 'active' || queue.length) return;
    const uid = state.activeUid;
    const played = [...decisions.current, { uid, action }];
    const profile = OPPONENTS.find((opponent) => opponent.id === setup.opponentId)?.profile ?? DEFAULT_PROFILE;
    const result = runBattle(setup as BattleSetup, played, createOpponentDecider(profile));
    if (result.error && result.error !== 'unfinished') {
      setNotice(result.error === 'energy' ? '기운이 부족해요.' : '지금은 그 행동을 할 수 없어요.');
      return;
    }
    const fresh = result.events.slice(consumed.current);
    consumed.current = result.events.length;
    decisions.current = played;
    setNotice(null);
    setState(result.state);
    setQueue((pending) => [...pending, ...fresh]);
  }

  function reset() {
    settleRun.current += 1;
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
              {chosenCards.map((card) => <li key={card.id}><CardArtwork card={card} /><span>{card.name}</span></li>)}
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
              <button className="btn btn-primary" disabled={!chosenLegal || starting} onClick={() => void start(daily.opponentId, 'daily')}>
                이 덱으로 전투<Icon name="arrow" />
              </button>
            </article>
          ))}
          <ul className="opponent-grid">
            {OPPONENTS.map((opponent) => (
              <li key={opponent.id}>
                <article className="opponent-card">
                  <header>
                    <div>
                      <h3>{opponent.name}</h3>
                      <p className="opponent-title">{opponent.title}</p>
                    </div>
                    <span className="difficulty">{DIFFICULTY_LABEL[opponent.difficulty] ?? opponent.difficulty}</span>
                  </header>
                  <p className="opponent-blurb">{opponent.blurb}</p>
 <p className="opponent-reward"><Icon name="ticket" />{opponent.reward.label} {opponent.reward.credits}장</p>
                  <button className="btn btn-dark" disabled={!chosenLegal || starting} onClick={() => void start(opponent.id, 'pve')}>
                    이 덱으로 전투<Icon name="arrow" />
                  </button>
                </article>
              </li>
            ))}
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
  const canAct = myTurn && !animating;
  const ability = active?.ability ?? null;
  const skillCost = ability?.cost ?? 0;
  const skillReady = !!active && !!ability && active.cooldown === 0 && active.energy >= skillCost;
  const actionHint = state.status !== 'active'
    ? null
    : animating ? '방금 일어난 일을 보여주는 중이에요.'
    : !myTurn ? `${active?.name ?? '상대'}의 차례를 기다리는 중이에요.`
    : !skillReady ? (active && active.cooldown > 0
      ? `스킬은 ${active.cooldown}턴 뒤에 다시 쓸 수 있어요.`
      : `스킬에는 기운 ${skillCost}이 필요해요. 지금 기운은 ${active?.energy ?? 0}.`)
    : '내 차례예요. 행동을 골라주세요.';
  const fxFor = (uid: string) => fx.find((item) => item.uid === uid) ?? null;

  return (
    <section className="battle-view" aria-labelledby="battle-arena-title">
      <div className="battle-stage">
        <header className="battle-head">
          <div>
            <p className="eyebrow">{state.kind === 'daily' ? 'DAILY CHALLENGE' : 'PVE BATTLE'}</p>
            <h1 id="battle-arena-title">{setup?.opponentName ?? '대련'}</h1>
            <p className="battle-rule"><Icon name="sparkle" />{modifierLabel(state.modifier)}</p>
          </div>
          <div className="battle-round">
            <span className="meta-label">라운드</span>
            <strong>{state.round}</strong>
            <small>상대 {state.sides.b.filter((combatant) => combatant.hp > 0).length} / {state.sides.b.length} 남음</small>
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
              <UnitTile key={combatant.uid} c={combatant} sig={signature(combatant)} card={byId.get(combatant.cardId)} fx={fxFor(combatant.uid)} active={activeUid === combatant.uid} reduced={reduced} />
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
          <div className="battle-actions sticky-bar">
            <button className="battle-action" disabled={!canAct} onClick={() => act('attack')}>
              <Icon name="hand" />
              <span>
                <strong>일반 공격</strong>
                <small>기운 소모 없음</small>
              </span>
            </button>
            <button className="battle-action is-skill" disabled={!canAct || !skillReady} onClick={() => act('skill')}>
              <Icon name="sparkle" />
              <span>
                <strong>{ability?.name ?? '스킬'}</strong>
                <small>기운 {skillCost}{ability && ability.cooldown > 0 ? ` · ${ability.cooldown}턴 대기` : ''}</small>
                {ability && <em>{ability.description}</em>}
              </span>
            </button>
            <p className="action-hint" role="status">
              <Icon name={animating || !myTurn ? 'clock' : skillReady ? 'check' : 'sparkle'} />
              {notice ?? actionHint}
            </p>
          </div>
        ) : (
          <div className="battle-actions result-panel">
            <div className="result-copy">
              <h2>{outcome === 'won' ? '승리했습니다.' : outcome === 'lost' ? '패배했습니다.' : outcome === 'invalid' ? '기록을 확인할 수 없어요.' : '무승부입니다.'}</h2>
              <p>{state.round}라운드{state.endReason === 'turn_limit' ? ' · 라운드 제한' : state.endReason === 'timeout' ? ' · 시간 초과' : ''}</p>
            </div>
            {settling && <p className="result-pending" role="status"><span className="loading-dot" />전투 기록을 정산하는 중이에요.</p>}
            {settleFailed && !settling && (
              <div className="result-pending" role="status">
                <p>보상 정산을 마치지 못했어요.</p>
                <button className="btn btn-dark" onClick={() => void settle()}>다시 확인하기</button>
              </div>
            )}
            {summary && (
              <div className="result-summary">
                {!!summary.rewards.length && (
                  <ul className="reward-list">
                    {summary.rewards.map((reward) => <li key={reward.label}><Icon name="ticket" /><span>{reward.label}</span><strong>+{reward.credits}</strong></li>)}
                  </ul>
                )}
                {!!summary.unlocked.length && (
                  <div className="result-unlocked">
                    <h3>새로 얻은 업적</h3>
                    <ul>
                      {summary.unlocked.map((id) => (
                        <li key={id}><span className="text-button">{ACHIEVEMENT_LABEL[id] ?? id}</span></li>
                      ))}
                    </ul>
                  </div>
                )}
                <dl className="result-stats">
                  {summary.mvpCardId && byId.get(summary.mvpCardId) && <div><dt>최고 활약</dt><dd>{byId.get(summary.mvpCardId)?.name}</dd></div>}
                  <div><dt>라운드</dt><dd>{summary.rounds}</dd></div>
                  <div><dt>가한 피해</dt><dd>{summary.damageDealt}</dd></div>
                </dl>
              </div>
            )}
            <div className="result-actions">
              <button className="btn btn-primary" onClick={reset} disabled={settling}>다시 전투<Icon name="arrow" /></button>
              <button className="text-button" onClick={() => onNavigate('deck')}>덱 정리</button>
              <button className="text-button" onClick={() => onNavigate('pull')}>카드 더 모으기</button>
            </div>
          </div>
        )}
      </div>
    </section>
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
