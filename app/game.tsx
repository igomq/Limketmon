'use client';

import { AnimatePresence, MotionConfig, motion, useMotionValue, useReducedMotion, useTransform, animate } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Card, PullResult, Snapshot } from '../lib/game';
import { RARITY_ORDER, RARITY_WEIGHTS } from '../lib/rules';
import { cardTitle, projectedPosition, selectCards, type CollectionFilter } from '../lib/collection';
import { Brand, CardArtwork, CardBack, CardButton, CardDetail, Icon, gentleSpring, spring } from './card-ui';

type Tab = 'home' | 'pull' | 'collection' | 'coupon';
type User = { email: string; displayName: string } | null;
type Feedback = { text: string; error: boolean } | null;
const tabs = [
  { id: 'home', label: '발견', icon: 'home' },
  { id: 'pull', label: '카드팩', icon: 'pack' },
  { id: 'collection', label: '도감', icon: 'grid' },
  { id: 'coupon', label: '쿠폰', icon: 'ticket' }
] as const;
const defaultFilter: CollectionFilter = { query: '', rarity: 'all', ownership: 'all', sort: 'rarity' };
const signIn = (tab: Tab) => `/signin-with-chatgpt?return_to=${encodeURIComponent(`/#${tab}`)}`;
const nextReset = () => Math.floor((Date.now() + 9 * 3600000) / 86400000) * 86400000 + 86400000 - 9 * 3600000;

export default function Game(props: { user: User; cards: Card[]; initial: Snapshot }) {
  return <MotionConfig reducedMotion="user" transition={spring}><CollectionApp {...props} /></MotionConfig>;
}

function CollectionApp({ user, cards, initial }: { user: User; cards: Card[]; initial: Snapshot }) {
  const reduced = useReducedMotion();
  const [tab, setTab] = useState<Tab>('home');
  const [snapshot, setSnapshot] = useState(initial);
  const [selected, setSelected] = useState<Card | null>(null);
  const [filter, setFilter] = useState<CollectionFilter>(defaultFilter);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [results, setResults] = useState<PullResult[]>([]);
  const [pullId, setPullId] = useState(0);
  const [count, setCount] = useState<1 | 5>(1);
  const inFlight = useRef(false);
  const mutation = useRef(0);
  const content = useRef<HTMLElement>(null);
  const inventory = useMemo(() => new Map(snapshot.inventory.map((item) => [item.cardId, item])), [snapshot.inventory]);

  const refresh = useCallback(async () => {
    if (!user || inFlight.current) return;
    const revision = mutation.current;
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json() as { snapshot: Snapshot };
      if (!inFlight.current && revision === mutation.current) setSnapshot(data.snapshot);
    } catch { /* Keep the last confirmed snapshot; the next visit retries. */ }
  }, [user]);

  useEffect(() => {
    const sync = () => {
      const hash = window.location.hash.slice(1);
      setTab(tabs.some((item) => item.id === hash) ? hash as Tab : 'home');
    };
    sync();
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => { window.removeEventListener('popstate', sync); window.removeEventListener('hashchange', sync); };
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => { timer = setTimeout(() => { void refresh(); schedule(); }, nextReset() - Date.now() + 1000); };
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    schedule();
    document.addEventListener('visibilitychange', visible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);

  function navigate(next: Tab) {
    if (tab === next) return;
    window.history.pushState(null, '', `#${next}`);
    setTab(next);
    setFeedback(null);
    window.scrollTo({ top: 0, behavior: 'instant' });
    requestAnimationFrame(() => content.current?.focus({ preventScroll: true }));
  }

  async function pull() {
    if (inFlight.current || !user) return;
    inFlight.current = true;
    mutation.current += 1;
    setBusy(true);
    setFeedback(null);
    setResults([]);
    try {
      const response = await fetch('/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count }) });
      const data = await response.json() as { error?: string; snapshot?: Snapshot; results?: PullResult[] };
      if (!response.ok || !data.snapshot || !data.results?.length) throw new Error(data.error || '결과를 확인하지 못했어요. 도감을 확인한 뒤 다시 시도해주세요.');
      setSnapshot(data.snapshot);
      setResults(data.results);
      setPullId((id) => id + 1);
    } catch (error) {
      setFeedback({ text: error instanceof Error ? error.message : '연결을 확인한 뒤 다시 시도해주세요.', error: true });
    } finally {
      inFlight.current = false;
      setBusy(false);
      void refresh();
    }
  }

  async function redeem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !user) return;
    const form = event.currentTarget;
    const code = new FormData(form).get('code');
    inFlight.current = true;
    mutation.current += 1;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch('/api/coupon', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
      const data = await response.json() as { error?: string; snapshot?: Snapshot };
      if (!response.ok || !data.snapshot) throw new Error(data.error || '쿠폰을 확인하지 못했어요. 다시 시도해주세요.');
      setSnapshot(data.snapshot);
      setFeedback({ text: '뽑기권 100장이 도착했어요. 새로운 카드를 만나보세요.', error: false });
      form.reset();
    } catch (error) {
      setFeedback({ text: error instanceof Error ? error.message : '연결을 확인한 뒤 다시 시도해주세요.', error: true });
    } finally { inFlight.current = false; setBusy(false); }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#content">본문으로 건너뛰기</a>
      <header className="topbar"><div className="topbar-inner">
        <button className="brand" onClick={() => navigate('home')} aria-label="LIMKETMON 발견 페이지"><Brand /></button>
        <nav className="main-nav" aria-label="주요 메뉴">{tabs.map((item) => <motion.button key={item.id} onClick={() => navigate(item.id)} className={tab === item.id ? 'active' : ''} aria-current={tab === item.id ? 'page' : undefined} whileTap={{ scale: 0.95 }}>
          {tab === item.id && <motion.span className="nav-indicator" layoutId="navigation" transition={spring} />}
          <span className="nav-label"><Icon name={item.icon} />{item.label}</span>
          {item.id === 'pull' && user && snapshot.freeAvailable && <i className="nav-dot" aria-label="무료 뽑기 가능" />}
        </motion.button>)}</nav>
        <div className="account-area">{user ? <><span className="credit-pill"><Icon name="ticket" /><strong>{snapshot.credits.toLocaleString('ko-KR')}</strong><span className="sr-only">뽑기권</span></span><a className="icon-button" href="/signout-with-chatgpt?return_to=%2F" aria-label="로그아웃" title="로그아웃"><Icon name="logout" /></a></> : <a className="sign-in-link" href={signIn(tab)}>로그인<Icon name="arrow" /></a>}</div>
      </div></header>
      <main id="content" ref={content} tabIndex={-1} className="page">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div key={tab} className="view-stage" initial={{ opacity: 0, y: reduced ? 0 : 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ ...gentleSpring, opacity: { duration: 0.12 } }}>
            {tab === 'home' && <HomeView user={user} snapshot={snapshot} cards={cards} onNavigate={navigate} onOpen={setSelected} />}
            {tab === 'pull' && <PullView user={user} snapshot={snapshot} count={count} onCount={setCount} busy={busy} results={results} pullId={pullId} onPull={pull} onOpen={setSelected} onNavigate={navigate} />}
            {tab === 'collection' && <CollectionView user={user} snapshot={snapshot} cards={cards} filter={filter} onFilter={setFilter} onOpen={setSelected} onNavigate={navigate} />}
            {tab === 'coupon' && <CouponView user={user} busy={busy} feedback={feedback} onSubmit={redeem} onNavigate={navigate} />}
          </motion.div>
        </AnimatePresence>
        {feedback && tab !== 'coupon' && <p className={`feedback ${feedback.error ? 'error' : 'success'}`} role={feedback.error ? 'alert' : 'status'}><Icon name={feedback.error ? 'clock' : 'check'} />{feedback.text}</p>}
      </main>
      <footer className="footer"><span>limketmon. <span>이 정도면 우정입니다.</span></span><span>ORIGINAL COLLECTION · {cards.length} CARDS</span></footer>
      <AnimatePresence>{selected && <CardDetail key={selected.id} card={selected} quantity={inventory.get(selected.id)?.quantity ?? 0} obtainedAt={inventory.get(selected.id)?.firstObtainedAt} onClose={() => setSelected(null)} />}</AnimatePresence>
    </div>
  );
}

function HomeView({ user, snapshot, cards, onNavigate, onOpen }: { user: User; snapshot: Snapshot; cards: Card[]; onNavigate: (tab: Tab) => void; onOpen: (card: Card) => void }) {
  const reduced = useReducedMotion();
  const showcase = [9, 7, 1].map((version) => cards.find((card) => card.version === version)!).filter(Boolean);
  const recent = selectCards(cards, snapshot.inventory, { ...defaultFilter, ownership: 'owned', sort: 'recent' }).slice(0, 4);
  const featured = recent.length ? recent : [18, 32, 41, 20].map((version) => cards.find((card) => card.version === version)!).filter(Boolean);
  const totalOwned = snapshot.inventory.reduce((sum, item) => sum + item.quantity, 0);
  return <>
    <section className="discovery-hero" aria-labelledby="discovery-title">
      <div className="hero-copy"><p className="eyebrow"><span className="live-dot" />ONE GUY. TOO MANY CARDS.</p>
        <h1 id="discovery-title">신규는 한 명,<br /><span>짤은 {cards.length}종.</span></h1>
        <p className="hero-description">사진첩에만 두기 아까운 표정들.<br />굳이 카드로 만들어봤습니다.</p>
        <div className="hero-actions"><motion.button className="btn btn-primary" onClick={() => onNavigate('pull')} whileTap={{ scale: 0.97 }}>{user && snapshot.freeAvailable ? '오늘의 무료 카드 열기' : '카드팩 열기'}<Icon name="arrow" /></motion.button><button className="text-button" onClick={() => onNavigate('collection')}>도감 둘러보기<Icon name="chevron" /></button></div>
        <p className="hero-note"><Icon name="sparkle" />매일 한 장 무료 · {cards.length}종의 임신규</p>
      </div>
      <div className="hero-gallery" aria-label="컬렉션 미리보기">{showcase.map((card, index) => <motion.div key={card.id} className={`hero-card hero-card-${index}`} initial={reduced ? false : { opacity: 0, y: 35, rotate: 0 }} animate={{ opacity: 1, y: 0, rotate: [-13, 3, 16][index] }} transition={{ ...gentleSpring, delay: reduced ? 0 : index * 0.08 }}><CardButton card={card} onClick={() => onOpen(card)} priority /></motion.div>)}
        <div className="gallery-caption"><span className="tiny-cross">+</span>본인도 이 사진이 여기 있는지 모를 수 있음.<span>01 — {cards.length}</span></div>
      </div>
    </section>
    {user ? <section className="collector-strip" aria-label="나의 수집 현황"><div className="collector-identity"><span className="avatar">{Array.from(user.displayName)[0]}</span><div><span className="meta-label">MY COLLECTION</span><strong>{user.displayName}</strong></div></div><div><span className="meta-label">발견한 카드</span><strong>{snapshot.inventory.length}<small> / {cards.length}</small></strong></div><div><span className="meta-label">모은 카드</span><strong>{totalOwned}<small> 장</small></strong></div><button className="daily-status" onClick={() => onNavigate('pull')}><span className="status-dot" data-ready={snapshot.freeAvailable} />{snapshot.freeAvailable ? '무료 팩이 기다리고 있어요' : '오늘의 무료 팩 개봉 완료'}<Icon name="arrow" /></button></section> : <section className="welcome-strip"><span><Icon name="sparkle" /><strong>신규 수집에 동참하시겠어요?</strong><span>로그인하면 카드가 내 도감에 차곡차곡.</span></span><a href={signIn('pull')}>ChatGPT로 시작하기<Icon name="arrow" /></a></section>}
    <section className="home-collection" aria-labelledby="home-collection-title"><div className="section-head"><div><p className="eyebrow">{recent.length ? 'RECENTLY COLLECTED' : 'CAUGHT ON CAMERA'}</p><h2 id="home-collection-title">{recent.length ? '방금 잡은 신규들' : '이런 신규는 어때요?'}</h2></div><button className="text-button" onClick={() => onNavigate('collection')}>전체 도감<Icon name="arrow" /></button></div>
      <div className="featured-grid">{featured.map((card) => <div className="gallery-item" key={card.id}><CardButton card={card} quantity={snapshot.inventory.find((item) => item.cardId === card.id)?.quantity} onClick={() => onOpen(card)} /><div className="gallery-item-caption"><span>{cardTitle(card)}</span><span className={`rarity-text rarity-${card.rarity}`}>{card.rarity}</span></div></div>)}</div>
    </section>
    <section className="collection-invite"><div><span className="eyebrow">SAME GUY. DIFFERENT PROBLEM.</span><h2>아직 안 본 신규가 있다면.</h2><p>{user ? `${cards.length - snapshot.inventory.length}종의 신규가 아직 안 잡혔습니다.` : '표정은 제각각. 아무튼 전부 같은 사람.'}</p></div><button className="btn btn-dark" onClick={() => onNavigate(user ? 'pull' : 'collection')}>{user ? '신규 한 장 더 뽑기' : `${cards.length}종의 신규 보기`}<Icon name="arrow" /></button></section>
  </>;
}

function ResetClock() {
  const [remaining, setRemaining] = useState('매일 자정 KST');
  useEffect(() => {
    const update = () => {
      const minutes = Math.max(1, Math.ceil((nextReset() - Date.now()) / 60000));
      setRemaining(`${Math.floor(minutes / 60)}시간 ${minutes % 60}분 후 충전`);
    };
    update();
    const timer = setInterval(update, 60000);
    return () => clearInterval(timer);
  }, []);
  return <span>{remaining}</span>;
}

function PullView({ user, snapshot, count, onCount, busy, results, pullId, onPull, onOpen, onNavigate }: { user: User; snapshot: Snapshot; count: 1 | 5; onCount: (count: 1 | 5) => void; busy: boolean; results: PullResult[]; pullId: number; onPull: () => void; onOpen: (card: Card) => void; onNavigate: (tab: Tab) => void }) {
  const reduced = useReducedMotion();
  const canPull = count === 1 ? snapshot.freeAvailable || snapshot.credits >= 1 : snapshot.credits >= 5;
  const cost = count === 1 && snapshot.freeAvailable ? '무료' : `뽑기권 ${count}장`;
  const newCount = results.filter((result) => result.isNew).length;
  return <section className="pull-view" aria-labelledby="pull-title">
    <div className="section-head"><div><p className="eyebrow">DAILY DOSE OF SINGYU</p><h1 id="pull-title">오늘의 신규깡.</h1></div><span className="edition-label">ORIGINALS / VOL. 01</span></div>
    <div className="pull-layout"><div className={`opening-table ${results.length ? 'has-results' : ''}`}>
      <div className="table-label"><Icon name="sparkle" />{results.length ? 'LOOK WHO SHOWED UP' : 'SPOILER: IT’S SINGYU'}</div>
      {results.length ? <RevealDeck key={pullId} results={results} onOpen={onOpen} /> : <div className="sealed-deck">
        <motion.div className="deck-layer layer-two" animate={{ rotate: busy && !reduced ? 9 : 6, x: busy && !reduced ? 20 : 10, y: 4 }} transition={spring}><CardBack count={count} /></motion.div>
        <motion.div className="deck-layer layer-one" animate={{ rotate: busy && !reduced ? -8 : -5, x: busy && !reduced ? -16 : -7, y: 2 }} transition={spring}><CardBack count={count} /></motion.div>
        <motion.button className="sealed-front" disabled={busy || (!!user && !canPull)} aria-label={busy ? '카드를 불러오는 중' : '선택한 카드팩 열기'} onClick={() => { if (user) onPull(); else window.location.assign(signIn('pull')); }} animate={busy && !reduced ? { y: -12, scale: 0.98 } : { y: 0, scale: 1 }} whileHover={reduced || busy ? undefined : { y: -9, rotate: -2 }} whileTap={reduced ? undefined : { scale: 0.96 }} transition={spring}><CardBack count={count} /></motion.button>
      </div>}
      <p className="table-hint" role="status">{busy ? <><span className="loading-dot" />카드를 가져오고 있어요…</> : results.length ? `${results.length}장 획득 · ${newCount ? `새로운 카드 ${newCount}장` : '컬렉션에 수량이 추가됐어요'}` : <><Icon name="hand" />팩을 누르면 임신규가 나옵니다. 확정입니다.</>}</p>
    </div><aside className="pack-options"><div className="available-label"><span className="live-dot" />{user && snapshot.freeAvailable ? '오늘의 무료 팩 준비 완료' : '매일 한 장, 무료로'}</div><h2>오늘은 또<br />무슨 신규?</h2><p>같은 사람 맞습니다.<br />일단 한 장 뽑아보세요.</p>
      <div className="pack-selector" aria-label="뽑기 수량">{([1, 5] as const).map((value) => <button key={value} aria-pressed={count === value} disabled={busy} onClick={() => onCount(value)}>{count === value && <motion.span className="pack-selection" layoutId="pack-count" />}<span><strong>{value === 1 ? '1장 뽑기' : '5장 뽑기'}</strong><small>{value === 1 && snapshot.freeAvailable && user ? '오늘 1회 무료' : `뽑기권 ${value}장`}</small></span>{value === count && <Icon name="check" />}</button>)}</div>
      {user ? <motion.button className="btn btn-primary open-pack-button" disabled={busy || !canPull} onClick={onPull} whileTap={{ scale: 0.98 }}>{busy ? '카드 확인 중…' : results.length ? `새 팩 열기 · ${cost}` : `팩 열기 · ${cost}`}<Icon name="arrow" /></motion.button> : <a className="btn btn-primary open-pack-button" href={signIn('pull')}>로그인하고 무료로 열기<Icon name="arrow" /></a>}
      {user && !canPull && !busy && <p className="insufficient">뽑기권이 부족해요. <button onClick={() => onNavigate('coupon')}>쿠폰 입력하기<Icon name="arrow" /></button></p>}
      <div className="pack-balance"><span>내 뽑기권 <strong>{user ? `${snapshot.credits}장` : '로그인 후 확인'}</strong></span><span><Icon name="clock" /><ResetClock /></span></div>
      <details className="odds"><summary>카드 등장 확률<span>확인하기 +</span></summary><div>{RARITY_ORDER.map((rarity) => <div key={rarity}><span className={`rarity-text rarity-${rarity}`}>{rarity}</span><strong>{Math.round(RARITY_WEIGHTS.find(([r]) => r === rarity)![1] * 100)}%</strong></div>)}</div><p>모든 뽑기는 독립적으로 진행됩니다. 5장 뽑기에는 무료 횟수가 사용되지 않습니다.</p></details>
    </aside></div>
    {!!results.length && <div className="result-actions"><p><Icon name="check" />모든 카드는 이미 도감에 안전하게 저장됐어요.</p><button className="text-button" onClick={() => onNavigate('collection')}>도감에서 보기<Icon name="arrow" /></button></div>}
  </section>;
}

function RevealDeck({ results, onOpen }: { results: PullResult[]; onOpen: (card: Card) => void }) {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  const [all, setAll] = useState(false);
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-250, 0, 250], [-16, 0, 16]);
  const faceUp = revealed.has(index);
  const result = results[index]!;
  const navigation = useRef(0);

  function reveal() { setRevealed((old) => new Set([...old, index])); }
  async function advance(direction: number, velocity = 0) {
    const run = ++navigation.current;
    const next = index + direction;
    if (next < 0 || next >= results.length) { animate(x, 0, { ...spring, velocity }); return; }
    if (!reduced) await animate(x, direction > 0 ? -340 : 340, { ...spring, velocity });
    if (run !== navigation.current) return;
    x.jump(0);
    setIndex(next);
  }

  if (all) return <div className={`all-results ${results.length === 1 ? 'one-result' : ''}`}>{results.map((item, i) => <motion.div key={i} className="result-thumbnail" initial={{ opacity: 0, y: reduced ? 0 : 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...gentleSpring, delay: reduced ? 0 : i * 0.055 }}><CardButton card={item.card} quantity={item.quantity} onClick={() => onOpen(item.card)} />{item.isNew && <span className="new-label">NEW</span>}</motion.div>)}</div>;

  return <div className="reveal-experience"><div className="reveal-deck">
    {index < results.length - 1 && <div className="reveal-under"><CardBack /></div>}
    <motion.div key={index} className="swipe-card" style={{ x, rotate: reduced ? 0 : rotate }} drag={faceUp && !reduced ? 'x' : false} dragConstraints={{ left: 0, right: 0 }} dragElastic={0.65} dragTransition={{ bounceStiffness: 360, bounceDamping: 34 }} onDragStart={() => { navigation.current += 1; x.stop(); }} onDragEnd={(_, info) => {
      const projected = projectedPosition(x.get(), info.velocity.x);
      if (Math.abs(projected) > 90 && Math.sign(info.velocity.x || projected) === Math.sign(projected)) void advance(projected < 0 ? 1 : -1, info.velocity.x);
      else animate(x, 0, { ...spring, velocity: info.velocity.x });
    }} initial={{ opacity: 0, scale: reduced ? 1 : 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={spring}>
      <motion.button className={`flip-card ${faceUp ? 'is-revealed' : ''}`} aria-label={faceUp ? `${cardTitle(result.card)} 상세 보기` : `${index + 1}번째 카드 뒤집기`} onClick={() => faceUp ? onOpen(result.card) : reveal()} whileTap={reduced ? undefined : { scale: 0.97 }}>
        <motion.div className="flip-inner" animate={{ rotateY: reduced ? 0 : faceUp ? 180 : 0 }} transition={{ type: 'spring', stiffness: 130, damping: 22, mass: 0.8 }}>
          <div className="flip-back" aria-hidden={faceUp} style={reduced ? { display: faceUp ? 'none' : 'block' } : undefined}><CardBack /></div>
          <div className="flip-front" aria-hidden={!faceUp} style={reduced ? { display: faceUp ? 'block' : 'none', transform: 'none' } : undefined}><CardArtwork card={result.card} quantity={result.quantity} priority /></div>
        </motion.div>
      </motion.button>
      {faceUp && result.isNew && <motion.span className="new-label" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}>NEW DISCOVERY</motion.span>}
    </motion.div>
  </div><div className="reveal-caption" aria-live="polite"><strong>{faceUp ? cardTitle(result.card) : '어떤 카드일까요?'}</strong><span>{faceUp ? `${result.card.rarity} · ${result.isNew ? '새로운 신규 포착' : `${result.quantity}장째 수집`}` : '카드를 눌러 뒤집어보세요'}</span></div>
    <div className="deck-controls"><button className="icon-button" disabled={index === 0} onClick={() => void advance(-1)} aria-label="이전 카드"><Icon name="back" /></button><span>{index + 1}<small> / {results.length}</small></span><button className="icon-button" disabled={index === results.length - 1} onClick={() => void advance(1)} aria-label="다음 카드"><Icon name="arrow" /></button></div>
    <button className="text-button reveal-all" onClick={() => setAll(true)}>{results.length > 1 ? '한 번에 모두 보기' : '카드 바로 보기'}<Icon name="grid" /></button>
  </div>;
}

function CollectionView({ user, snapshot, cards, filter, onFilter, onOpen, onNavigate }: { user: User; snapshot: Snapshot; cards: Card[]; filter: CollectionFilter; onFilter: (filter: CollectionFilter) => void; onOpen: (card: Card) => void; onNavigate: (tab: Tab) => void }) {
  const reduced = useReducedMotion();
  const inventory = useMemo(() => new Map(snapshot.inventory.map((item) => [item.cardId, item])), [snapshot.inventory]);
  const visible = useMemo(() => selectCards(cards, snapshot.inventory, filter), [cards, snapshot.inventory, filter]);
  function change(patch: Partial<CollectionFilter>) { onFilter({ ...filter, ...patch }); }
  return <section className="collection-view" aria-labelledby="collection-title">
    <header className="section-head"><div><p className="eyebrow">THE COMPLETE ARCHIVE</p><h1 id="collection-title">임신규 관찰 도감.</h1><p>{user ? '한 사람을 이렇게까지 모아봅니다.' : `${cards.length}종의 임신규. 표정만 봐도 등급이 궁금해집니다.`}</p></div><div className="completion-number"><strong>{user ? snapshot.inventory.length : cards.length}</strong><span>/ {cards.length}<small>{user ? '수집한 카드' : '전체 카드'}</small></span></div></header>
    {user && <div className="archive-progress"><div role="progressbar" aria-label="도감 완성도" aria-valuenow={snapshot.completion} aria-valuemin={0} aria-valuemax={100}><motion.span animate={{ scaleX: snapshot.completion / 100 }} /></div><span>{snapshot.completion}% 완성</span></div>}
    <div className="collection-toolbar"><div className="ownership-filter" aria-label="수집 상태">{([['all', '전체'], ['owned', '수집한 카드'], ['missing', '아직 못 만난 카드']] as const).map(([value, label]) => <button key={value} disabled={!user && value !== 'all'} aria-pressed={filter.ownership === value} onClick={() => change({ ownership: value })}>{label}{value === 'owned' && user && <span>{snapshot.inventory.length}</span>}</button>)}</div><label className="search-field"><Icon name="search" /><span className="sr-only">카드 이름, 번호, 스킬 검색</span><input type="search" value={filter.query} onChange={(event) => change({ query: event.target.value })} placeholder="이름, 번호, 스킬 검색" /></label></div>
    <div className="filter-row"><div className="rarity-filters" aria-label="등급 필터"><button aria-pressed={filter.rarity === 'all'} onClick={() => change({ rarity: 'all' })}>모든 등급</button>{RARITY_ORDER.map((rarity) => <button key={rarity} className={`rarity-${rarity}`} aria-pressed={filter.rarity === rarity} onClick={() => change({ rarity })}><i />{rarity}</button>)}</div><label className="sort-select"><span className="sr-only">정렬</span><select value={filter.sort} onChange={(event) => change({ sort: event.target.value as CollectionFilter['sort'] })}><option value="rarity">희귀도순</option><option value="number">번호순</option>{user && <option value="recent">최근 수집순</option>}</select></label></div>
    <p className="results-count" role="status">{visible.length}개의 카드{filter.query && ` · “${filter.query}” 검색 결과`}</p>
    {visible.length ? <motion.div className="archive-grid" layout={reduced ? false : 'position'}>{visible.map((card) => {
      const owned = inventory.get(card.id);
      return <motion.div layout={reduced ? false : 'position'} key={card.id} className={`archive-item ${user && !owned ? 'not-collected' : ''}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ ...spring, opacity: { duration: 0.2 } }}><CardButton card={card} quantity={owned?.quantity} onClick={() => onOpen(card)} /><div className="archive-item-caption"><strong>{cardTitle(card)}</strong><span>{owned ? <><Icon name="check" />보유 {owned.quantity}장</> : user ? '미수집 · 미리보기' : `NO. ${String(card.version).padStart(3, '0')}`}</span></div></motion.div>;
    })}</motion.div> : <div className="empty-state"><Icon name="search" /><h2>{filter.ownership === 'owned' && !snapshot.inventory.length ? '아직 잡힌 신규가 없어요.' : '해당하는 카드가 없어요.'}</h2><p>{filter.ownership === 'owned' && !snapshot.inventory.length ? '오늘의 무료 팩에서 첫 신규를 잡아보세요.' : '다른 검색어를 쓰거나 필터를 바꿔보세요.'}</p><button className="btn btn-dark" onClick={() => { if (filter.ownership === 'owned' && !snapshot.inventory.length) onNavigate('pull'); else onFilter(defaultFilter); }}>{filter.ownership === 'owned' && !snapshot.inventory.length ? '무료 카드 열기' : '필터 초기화'}<Icon name="arrow" /></button></div>}
  </section>;
}

function CouponView({ user, busy, feedback, onSubmit, onNavigate }: { user: User; busy: boolean; feedback: Feedback; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onNavigate: (tab: Tab) => void }) {
  return <section className="coupon-view" aria-labelledby="coupon-title"><div className="section-head"><div><p className="eyebrow">MORE PULLS. SAME GUY.</p><h1 id="coupon-title">뽑을 핑계, 여기 있습니다.</h1><p>뽑기권이 없어서 못 놀리는 일은 없도록.</p></div></div><div className="coupon-layout"><div className="welcome-ticket"><span className="eyebrow">WELCOME TO THE SINGYU CLUB</span><div className="ticket-value">100<span>장의<br />신규 소환권</span></div><p>처음 오셨으니 100장 드립니다.</p><div className="ticket-code"><span>WELCOME CODE</span><strong>LIMKETMON</strong><Icon name="ticket" /></div><span className="ticket-footnote">계정당 1회 · 뽑기권 100장</span></div><div className="coupon-form-panel"><Icon name="ticket" /><h2>신규 소환권 충전소.</h2><p>가지고 있는 쿠폰 코드를 입력해주세요.</p>{user ? <form onSubmit={onSubmit}><label htmlFor="coupon-code">쿠폰 코드</label><input id="coupon-code" name="code" placeholder="LIMKETMON" maxLength={64} required autoComplete="off" autoCapitalize="characters" spellCheck={false} /><button className="btn btn-primary" disabled={busy}>{busy ? '쿠폰 확인 중…' : '뽑기권 받기'}<Icon name="arrow" /></button></form> : <a className="btn btn-primary" href={signIn('coupon')}>로그인하고 선물 받기<Icon name="arrow" /></a>}{feedback && <div className={`feedback ${feedback.error ? 'error' : 'success'}`} role={feedback.error ? 'alert' : 'status'}><Icon name={feedback.error ? 'clock' : 'check'} /><span>{feedback.text}{!feedback.error && <button className="text-button" onClick={() => onNavigate('pull')}>카드팩 열러 가기<Icon name="arrow" /></button>}</span></div>}<p className="coupon-note">받은 뽑기권은 내 계정에 저장됩니다.<br />이미 사용한 쿠폰은 다시 사용할 수 없어요.</p></div></div></section>;
}
