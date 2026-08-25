'use client';

import {
  AnimatePresence,
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useSpring
} from 'motion/react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';
import type { Card, PullResult, Snapshot } from '../lib/game';
import { rarityRank, type Rarity } from '../lib/rules';
import ThreeStage, { type OpeningPhase } from './three-stage';

type Tab = 'home' | 'pull' | 'collection' | 'coupon';
type PullData = { snapshot: Snapshot; results: PullResult[] };

const tabs: Array<[Tab, string]> = [
  ['home', '홈'],
  ['pull', '뽑기'],
  ['collection', '도감'],
  ['coupon', '쿠폰']
];
const spring = { type: 'spring' as const, stiffness: 430, damping: 34, mass: 0.7 };
const cardSpring = { stiffness: 230, damping: 25, mass: 0.72 };
const rarityPause: Record<Rarity, number> = { N: 100, R: 200, SR: 380, SSR: 820, UR: 1180 };

export default function Game({
  user,
  cards,
  initial
}: {
  user: { email: string; displayName: string };
  cards: Card[];
  initial: Snapshot;
}) {
  const reduceMotion = useReducedMotion();
  const [tab, setTab] = useState<Tab>('home');
  const [snapshot, setSnapshot] = useState(initial);
  const [results, setResults] = useState<PullResult[]>([]);
  const [selected, setSelected] = useState<Card | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [openingPhase, setOpeningPhase] = useState<OpeningPhase>('idle');
  const [openingCount, setOpeningCount] = useState<1 | 5>(1);
  const [cinematicCard, setCinematicCard] = useState<Card | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const firstView = useRef(true);
  const focusReturn = useRef<HTMLElement | null>(null);
  const runRef = useRef(0);
  const skipRef = useRef(false);
  const timers = useRef(new Map<number, () => void>());

  const inventory = useMemo(
    () => new Map(snapshot.inventory.map((item) => [item.cardId, item])),
    [snapshot.inventory]
  );
  const sortedCards = useMemo(
    () => [...cards].sort((a, b) => rarityRank(a.rarity) - rarityRank(b.rarity) || a.version - b.version),
    [cards]
  );
  const ownedCount = snapshot.inventory.length;

  const cancelTimers = useCallback(() => {
    for (const [timer, resolve] of timers.current) {
      window.clearTimeout(timer);
      resolve();
    }
    timers.current.clear();
  }, []);

  const wait = useCallback((milliseconds: number) => new Promise<boolean>((resolve) => {
    if (milliseconds <= 0) return resolve(true);
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      resolve(true);
    }, milliseconds);
    timers.current.set(timer, () => resolve(false));
  }), []);

  useEffect(() => () => {
    runRef.current += 1;
    cancelTimers();
  }, [cancelTimers]);

  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    const frame = requestAnimationFrame(() => viewRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [tab]);

  useEffect(() => {
    const syncTab = () => {
      const hash = window.location.hash.slice(1);
      setTab(tabs.some(([item]) => item === hash) ? hash as Tab : 'home');
    };
    syncTab();
    window.addEventListener('popstate', syncTab);
    return () => window.removeEventListener('popstate', syncTab);
  }, []);

  const changeTab = useCallback((next: Tab) => {
    if (window.location.hash !== `#${next}`) window.history.pushState(null, '', `#${next}`);
    setTab(next);
    setMessage('');
  }, []);

  async function pull(count: 1 | 5) {
    const run = ++runRef.current;
    cancelTimers();
    skipRef.current = false;
    setBusy(true);
    setMessage('');
    setResults([]);
    setCinematicCard(null);
    setOpeningCount(count);

    const request = fetch('/api/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count })
    }).then(async (response): Promise<PullData> => {
      const data = (await response.json()) as { error?: string; snapshot?: Snapshot; results?: PullResult[] };
      if (!response.ok || !data.snapshot || !data.results) {
        throw new Error(data.error ?? '뽑기에 실패했습니다.');
      }
      return { snapshot: data.snapshot, results: data.results };
    });

    try {
      for (const [phase, duration] of [
        ['press', 130],
        ['charge', 480],
        ['tear', 180],
        ['flash', 120]
      ] as Array<[OpeningPhase, number]>) {
        if (run !== runRef.current) return;
        setOpeningPhase(phase);
        if (!(await wait(reduceMotion ? 0 : duration))) break;
      }

      if (run !== runRef.current) return;
      setOpeningPhase('back');
      const data = await request;
      if (run !== runRef.current) return;
      setSnapshot(data.snapshot);
      const best = [...data.results].sort((a, b) => rarityRank(a.card.rarity) - rarityRank(b.card.rarity))[0]!;
      setCinematicCard(best.card);

      if (skipRef.current || reduceMotion) {
        setResults(data.results);
        setOpeningPhase('result');
        return;
      }

      if (!(await wait(180)) || skipRef.current) {
        setResults(data.results);
        setOpeningPhase('result');
        return;
      }
      setOpeningPhase('anticipation');
      if (!(await wait(rarityPause[best.card.rarity])) || skipRef.current) {
        setResults(data.results);
        setOpeningPhase('result');
        return;
      }
      setOpeningPhase('flip');
      await wait(best.card.rarity === 'UR' ? 560 : best.card.rarity === 'SSR' ? 460 : 340);
      if (run !== runRef.current) return;
      setResults(data.results);
      setOpeningPhase('result');
    } catch (error) {
      if (run !== runRef.current) return;
      setMessage(error instanceof Error ? error.message : '뽑기에 실패했습니다.');
      setOpeningPhase('idle');
      setCinematicCard(null);
    } finally {
      if (run === runRef.current) setBusy(false);
    }
  }

  function skipOpening() {
    skipRef.current = true;
    cancelTimers();
    setOpeningPhase('back');
  }

  async function submitCoupon(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get('code');
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/coupon', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const data = (await response.json()) as { error?: string; snapshot?: Snapshot };
      if (!response.ok || !data.snapshot) throw new Error(data.error ?? '쿠폰 적용에 실패했습니다.');
      setSnapshot(data.snapshot);
      setMessage('쿠폰 적용 완료! 뽑기권 100개가 추가되었습니다.');
      event.currentTarget.reset();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '쿠폰 적용에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  function openCard(card: Card) {
    focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelected(card);
  }

  const closeCard = useCallback(() => setSelected(null), []);
  const restoreFocus = useCallback(() => focusReturn.current?.focus(), []);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#content">본문으로 건너뛰기</a>
      <header className="topbar">
        <motion.button className="brand" onClick={() => changeTab('home')} whileTap={{ scale: 0.97 }} transition={spring}>
          LIMKETMON
        </motion.button>
        <nav aria-label="주요 메뉴">
          {tabs.map(([item, label]) => (
            <motion.button
              key={item}
              className={tab === item ? 'active' : ''}
              onClick={() => changeTab(item)}
              aria-current={tab === item ? 'page' : undefined}
              whileTap={{ scale: 0.96 }}
              transition={spring}
            >
              {tab === item && <motion.span className="nav-indicator" layoutId="nav-indicator" transition={spring} />}
              <span>{label}</span>
            </motion.button>
          ))}
        </nav>
      </header>

      <main id="content" className="page">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={tab}
            ref={viewRef}
            className="view-stage"
            tabIndex={-1}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.995 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -5, scale: 0.998 }}
            transition={{ duration: reduceMotion ? 0.1 : 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            {tab === 'home' && (
              <HomeView
                user={user}
                snapshot={snapshot}
                ownedCount={ownedCount}
                totalCards={cards.length}
                onNavigate={changeTab}
              />
            )}

            {tab === 'pull' && (
              <section className="pull-view" aria-labelledby="pull-title">
                <header className="view-heading centered-heading">
                  <p className="eyebrow">DAILY CARD PACK</p>
                  <h1 id="pull-title">오늘의 카드팩</h1>
                  <p>매일 자정(KST)에 무료 뽑기가 충전됩니다.</p>
                </header>

                <AnimatePresence mode="wait" initial={false}>
                  {openingPhase === 'result' && results.length ? (
                    <motion.div
                      key="results"
                      className={`pull-results ${results.length === 1 ? 'single' : 'multi'}`}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                    >
                      {results.map((result, index) => (
                        <PullReveal
                          key={`${result.card.id}-${result.quantity}-${index}`}
                          result={result}
                          index={index}
                          single={results.length === 1}
                          onClick={() => openCard(result.card)}
                        />
                      ))}
                    </motion.div>
                  ) : (
                    <PackOpening
                      key="pack"
                      phase={openingPhase}
                      count={openingCount}
                      card={cinematicCard}
                      reduced={Boolean(reduceMotion)}
                    />
                  )}
                </AnimatePresence>

                <div className="pull-status" aria-live="polite" aria-atomic="true">
                  {openingPhase === 'result' && results.length
                    ? pullSummary(results)
                    : busy
                      ? openingStatus(openingPhase)
                      : '팩을 선택해 카드를 확인하세요.'}
                </div>

                <div className="pull-controls">
                  <motion.button
                    className="btn btn-primary pull-button"
                    disabled={busy || (!snapshot.freeAvailable && snapshot.credits < 1)}
                    onClick={() => pull(1)}
                    whileHover={busy ? undefined : { y: -2 }}
                    whileTap={busy ? undefined : { scale: 0.975 }}
                    transition={spring}
                  >
                    {busy ? '개봉 중…' : snapshot.freeAvailable ? '무료로 1장' : `1장 뽑기 · ${snapshot.credits}장`}
                  </motion.button>
                  <motion.button
                    className="btn pull-button"
                    disabled={busy || snapshot.credits < 5}
                    onClick={() => pull(5)}
                    whileHover={busy ? undefined : { y: -2 }}
                    whileTap={busy ? undefined : { scale: 0.975 }}
                    transition={spring}
                  >
                    5연속 뽑기 · 5장
                  </motion.button>
                </div>
                {busy && <button className="skip-opening" onClick={skipOpening}>연출 건너뛰기</button>}
                {message && <p className="notice error" role="alert">{message}</p>}
              </section>
            )}

            {tab === 'collection' && (
              <CollectionView
                cards={sortedCards}
                inventory={inventory}
                completion={snapshot.completion}
                ownedCount={ownedCount}
                onOpen={openCard}
              />
            )}

            {tab === 'coupon' && (
              <section className="coupon-view" aria-labelledby="coupon-title">
                <header className="view-heading centered-heading">
                  <p className="eyebrow">ONE-TIME REWARD</p>
                  <h1 id="coupon-title">쿠폰</h1>
                  <p>쿠폰 코드는 계정당 한 번만 사용할 수 있습니다.</p>
                </header>
                <motion.form
                  className="panel coupon-form"
                  onSubmit={submitCoupon}
                  initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.06, duration: 0.24 }}
                >
                  <label htmlFor="coupon">쿠폰 코드</label>
                  <input id="coupon" className="field" name="code" autoComplete="off" placeholder="코드를 입력하세요" required />
                  <motion.button className="btn btn-primary" disabled={busy} whileTap={{ scale: 0.975 }} transition={spring}>
                    {busy ? '확인 중…' : '사용하기'}
                  </motion.button>
                </motion.form>
                {message && (
                  <p className={`notice ${message.startsWith('쿠폰 적용') ? 'success' : 'error'}`} role="status">
                    {message}
                  </p>
                )}
              </section>
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      <AnimatePresence onExitComplete={restoreFocus}>
        {selected && <CardModal card={selected} quantity={inventory.get(selected.id)?.quantity ?? 0} onClose={closeCard} />}
      </AnimatePresence>
    </div>
  );
}

function HomeView({
  user,
  snapshot,
  ownedCount,
  totalCards,
  onNavigate
}: {
  user: { email: string; displayName: string };
  snapshot: Snapshot;
  ownedCount: number;
  totalCards: number;
  onNavigate: (tab: Tab) => void;
}) {
  return (
    <>
      <header className="hero">
        <p className="eyebrow">PREMIUM CARD COLLECTION</p>
        <h1>LIMKETMON</h1>
        <p>한 장씩 발견하고, 나만의 도감을 완성하세요.</p>
      </header>
      <section className="panel status" aria-labelledby="collection-status">
        <div className="who">
          <div><span className="welcome">COLLECTOR</span><strong>{user.displayName}</strong></div>
          <a href="/signout-with-chatgpt?return_to=%2F">로그아웃</a>
        </div>
        <h2 id="collection-status" className="sr-only">수집 현황</h2>
        <dl className="stats">
          <div><dt>오늘 무료 뽑기</dt><dd className={snapshot.freeAvailable ? 'ok' : ''}><AnimatedValue value={snapshot.freeAvailable ? '가능' : '완료'} /></dd></div>
          <div><dt>뽑기권</dt><dd><AnimatedValue value={snapshot.credits} /></dd></div>
          <div><dt>도감 완성도</dt><dd><AnimatedValue value={`${snapshot.completion}%`} /><small>{ownedCount}/{totalCards}</small></dd></div>
        </dl>
        <div className="progress" role="progressbar" aria-label="도감 완성도" aria-valuenow={snapshot.completion} aria-valuemin={0} aria-valuemax={100}>
          <motion.span animate={{ scaleX: snapshot.completion / 100 }} transition={spring} />
        </div>
      </section>
      <section className="actions" aria-label="빠른 메뉴">
        <motion.button className="btn btn-primary" onClick={() => onNavigate('pull')} whileHover={{ y: -2 }} whileTap={{ scale: 0.975 }} transition={spring}>카드팩 열기</motion.button>
        <motion.button className="btn" onClick={() => onNavigate('collection')} whileHover={{ y: -2 }} whileTap={{ scale: 0.975 }} transition={spring}>도감 보기</motion.button>
        <motion.button className="btn" onClick={() => onNavigate('coupon')} whileHover={{ y: -2 }} whileTap={{ scale: 0.975 }} transition={spring}>쿠폰 입력</motion.button>
      </section>
    </>
  );
}

function CollectionView({ cards, inventory, completion, ownedCount, onOpen }: {
  cards: Card[];
  inventory: Map<string, Snapshot['inventory'][number]>;
  completion: number;
  ownedCount: number;
  onOpen: (card: Card) => void;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <section className="collection-view" aria-labelledby="collection-title">
      <ThreeStage mode="ambient" />
      <div className="collection-content">
        <header className="section-head">
          <div><p className="eyebrow">CARD ARCHIVE</p><h1 id="collection-title">카드 도감</h1><p>희귀도 순 · UR에서 N까지</p></div>
          <div className="collection-total" aria-label={`총 ${cards.length}장 중 ${ownedCount}장 수집`}><strong><AnimatedValue value={ownedCount} /></strong><span>/ {cards.length}</span></div>
        </header>
        <div className="collection-progress" aria-hidden="true"><motion.span animate={{ scaleX: completion / 100 }} transition={spring} /></div>
        <div className="rarity-order" aria-label="희귀도 순서">
          {(['UR', 'SSR', 'SR', 'R', 'N'] as Rarity[]).map((rarity) => <span key={rarity} className={`rarity-${rarity}`}>{rarity}</span>)}
        </div>
        <div className="card-grid">
          {cards.map((card, index) => {
            const item = inventory.get(card.id);
            return (
              <motion.div
                key={card.id}
                className="grid-card-slot"
                initial={reduceMotion ? false : { opacity: 0, y: item ? 14 : 8, scale: item ? 0.97 : 0.99 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ delay: reduceMotion ? 0 : Math.min(index * 0.025, 0.4), duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
                {item ? (
                  <CardView card={card} quantity={item.quantity} onClick={() => onOpen(card)} />
                ) : (
                  <div className={`card locked rarity-${card.rarity}`} aria-label={`미획득 카드, ${card.rarity} 등급, 번호 ${card.version}`}>
                    <span aria-hidden="true">L</span><b>{card.rarity}</b><small>NO. {String(card.version).padStart(3, '0')}</small>
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function AnimatedValue({ value }: { value: string | number }) {
  return (
    <span className="animated-value">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={String(value)} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}>{value}</motion.span>
      </AnimatePresence>
    </span>
  );
}

function CardView({ card, quantity, onClick, featured = false }: { card: Card; quantity: number; onClick: () => void; featured?: boolean }) {
  const reduceMotion = useReducedMotion();
  const rotateXTarget = useMotionValue(0);
  const rotateYTarget = useMotionValue(0);
  const artXTarget = useMotionValue(0);
  const artYTarget = useMotionValue(0);
  const glareX = useMotionValue(50);
  const glareY = useMotionValue(35);
  const rotateX = useSpring(rotateXTarget, cardSpring);
  const rotateY = useSpring(rotateYTarget, cardSpring);
  const artX = useSpring(artXTarget, cardSpring);
  const artY = useSpring(artYTarget, cardSpring);
  const glare = useMotionTemplate`radial-gradient(circle at ${glareX}% ${glareY}%, rgba(255,255,255,.48), rgba(255,255,255,.08) 18%, transparent 43%)`;

  function resetTilt() {
    rotateXTarget.set(0); rotateYTarget.set(0); artXTarget.set(0); artYTarget.set(0); glareX.set(50); glareY.set(35);
  }
  function tilt(event: ReactPointerEvent<HTMLButtonElement>) {
    if (reduceMotion || event.pointerType !== 'mouse') return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;
    rotateXTarget.set(y * -8); rotateYTarget.set(x * 9); artXTarget.set(x * -5); artYTarget.set(y * -5);
    glareX.set((x + 0.5) * 100); glareY.set((y + 0.5) * 100);
  }

  return (
    <motion.button
      className={`card rarity-${card.rarity} ${featured ? 'featured' : ''}`}
      onClick={onClick}
      onPointerMove={tilt}
      onPointerLeave={resetTilt}
      onPointerCancel={resetTilt}
      onPointerUp={resetTilt}
      aria-label={`${card.name}, ${card.rarity} 등급, 보유 ${quantity}장, 상세 보기`}
      style={{ rotateX, rotateY, transformPerspective: 900 }}
      whileHover={reduceMotion ? undefined : { scale: 1.018 }}
      whileTap={{ scale: 0.975 }}
      transition={spring}
    >
      <motion.img src={`/cards/${card.imageKey}`} alt="" draggable={false} style={{ x: artX, y: artY }} />
      <span className="card-vignette" aria-hidden="true" />
      <motion.span className="card-glare" aria-hidden="true" style={{ backgroundImage: glare }} />
      <span className="rarity"><i aria-hidden="true" />{card.rarity}</span>
      <span className="card-name">{card.name}{card.alias && <small>{card.alias}</small>}</span>
      {quantity > 1 && <b className="quantity">×{quantity}</b>}
    </motion.button>
  );
}

function PullReveal({ result, index, single, onClick }: { result: PullResult; index: number; single: boolean; onClick: () => void }) {
  const high = rarityRank(result.card.rarity) <= rarityRank('SR');
  return (
    <motion.div
      className={`reveal-frame rarity-${result.card.rarity} ${high ? `high-${result.card.rarity}` : ''}`}
      style={{ '--reveal-delay': `${Math.min(index * 80, 320)}ms` } as CSSProperties}
      initial={{ opacity: 0, y: 20, scale: 0.9, rotateY: 18 }}
      animate={{ opacity: 1, y: 0, scale: 1, rotateY: 0 }}
      transition={{ delay: Math.min(index * 0.08, 0.32), duration: 0.46, ease: [0.16, 1, 0.3, 1] }}
    >
      <CardView card={result.card} quantity={result.quantity} onClick={onClick} featured={single} />
      {result.isNew && <span className="new-badge">NEW</span>}
    </motion.div>
  );
}

function PackOpening({ phase, count, card, reduced }: { phase: OpeningPhase; count: 1 | 5; card: Card | null; reduced: boolean }) {
  const active = phase !== 'idle' && phase !== 'result';
  return (
    <motion.div
      className={`pack-stage phase-${phase} ${active ? 'is-opening' : ''}`}
      initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.015 }}
      transition={{ duration: reduced ? 0.1 : 0.24 }} aria-label={active ? openingStatus(phase) : '개봉 전 LIMKETMON 카드팩'} role="img"
    >
      <motion.div
        className="pack"
        animate={reduced ? undefined : phase === 'press' ? { scale: 0.96, y: 3 } : phase === 'charge' ? { scale: 1.015, y: -4 } : { scale: 1, y: 0 }}
        transition={spring}
      >
        <span className="pack-seal" aria-hidden="true" /><span className="pack-mark">L</span><b>LIMKETMON</b><small>{count === 5 ? 'FIVE CARD EDITION' : 'MYSTERY CARD'}</small>
      </motion.div>
      {active && !reduced && <ThreeStage mode="pack" phase={phase} rarity={card?.rarity ?? 'N'} cardImage={card ? `/cards/${card.imageKey}` : undefined} />}
      <span className="pack-aura" aria-hidden="true" />
    </motion.div>
  );
}

function pullSummary(results: PullResult[]): string {
  const best = [...results].sort((a, b) => rarityRank(a.card.rarity) - rarityRank(b.card.rarity))[0]!;
  const newCount = results.filter((result) => result.isNew).length;
  if (results.length === 1) return best.isNew ? 'NEW! 도감에 새 카드가 추가됐습니다.' : `중복 카드 · 보유 ×${best.quantity}`;
  return `최고 ${best.card.rarity} · 새 카드 ${newCount}장 · 총 ${results.length}장`;
}

function openingStatus(phase: OpeningPhase): string {
  return {
    idle: '팩을 선택해 카드를 확인하세요.', press: '팩을 여는 중', charge: '카드 에너지를 모으는 중', tear: '팩 봉인을 여는 중', flash: '카드가 나타납니다',
    back: '결과를 불러오는 중', anticipation: '희귀도를 확인하는 중', flip: '카드를 공개하는 중', result: '카드 공개 완료'
  }[phase];
}

function CardModal({ card, quantity, onClose }: { card: Card; quantity: number; onClose: () => void }) {
  const titleId = useId();
  const modalRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [showcaseReady, setShowcaseReady] = useState(false);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return onClose();
      if (event.key !== 'Tab' || !modalRef.current) return;
      const focusable = [...modalRef.current.querySelectorAll<HTMLElement>('button, a, input, [tabindex]:not([tabindex="-1"])')].filter((element) => !element.hasAttribute('disabled'));
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', onKeyDown); };
  }, [onClose]);

  return (
    <motion.div className="modal-backdrop" role="presentation" onMouseDown={onClose} initial={{ opacity: 0, backdropFilter: 'blur(0px)' }} animate={{ opacity: 1, backdropFilter: 'blur(16px)' }} exit={{ opacity: 0, backdropFilter: 'blur(0px)' }} transition={{ duration: 0.2 }}>
      <motion.section
        ref={modalRef} className={`modal panel rarity-${card.rarity}`} role="dialog" aria-modal="true" aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()} initial={{ opacity: 0, y: 24, scale: 0.94, rotateX: -5 }} animate={{ opacity: 1, y: 0, scale: 1, rotateX: 0 }}
        exit={{ opacity: 0, y: 14, scale: 0.97, rotateX: -3 }} transition={spring}
      >
        <button ref={closeRef} className="modal-close" onClick={onClose} aria-label="카드 상세 닫기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
        <div className={`modal-visual ${showcaseReady ? 'showcase-ready' : ''}`}>
          <img src={`/cards/${card.imageKey}`} alt={`${card.name} 카드 일러스트`} />
          <ThreeStage mode="showcase" rarity={card.rarity} cardImage={`/cards/${card.imageKey}`} onReady={setShowcaseReady} />
          <span className="showcase-sheen" aria-hidden="true" />
        </div>
        <div className="modal-copy">
          <span className="rarity"><i aria-hidden="true" />{card.rarity}</span>
          <h2 id={titleId}>{card.name}{card.alias && <small>{card.alias}</small>}</h2>
          <p className="skill"><strong>{card.skillName}</strong><br />{card.skillDescription}</p>
          <p className="flavor">{card.flavorText}</p>
          <dl className="card-stats"><div><dt>ATK</dt><dd>{card.attack}</dd></div><div><dt>DEF</dt><dd>{card.defense}</dd></div><div><dt>LUCK</dt><dd>{card.luck}</dd></div></dl>
          <p className="owned-count">보유 수량 <strong>×{quantity}</strong></p>
        </div>
      </motion.section>
    </motion.div>
  );
}
