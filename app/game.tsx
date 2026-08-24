'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Card, Snapshot } from '../lib/game';

type Tab = 'home' | 'pull' | 'collection' | 'coupon';

export default function Game({
  user,
  cards,
  initial
}: {
  user: { email: string; displayName: string };
  cards: Card[];
  initial: Snapshot;
}) {
  const [tab, setTab] = useState<Tab>('home');
  const [snapshot, setSnapshot] = useState(initial);
  const [result, setResult] = useState<{ card: Card; isNew: boolean; quantity: number } | null>(null);
  const [selected, setSelected] = useState<Card | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const inventory = useMemo(
    () => new Map(snapshot.inventory.map((item) => [item.cardId, item])),
    [snapshot.inventory]
  );

  async function pull() {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/pull', { method: 'POST' });
      const data = (await response.json()) as {
        error?: string;
        snapshot: Snapshot;
        card: Card;
        isNew: boolean;
        quantity: number;
      };
      if (!response.ok) throw new Error(data.error ?? '뽑기에 실패했습니다.');
      setSnapshot(data.snapshot);
      setResult({ card: data.card, isNew: data.isNew, quantity: data.quantity });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '뽑기에 실패했습니다.');
    } finally {
      setBusy(false);
    }
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
      const data = (await response.json()) as { error?: string; snapshot: Snapshot };
      if (!response.ok) throw new Error(data.error ?? '쿠폰 적용에 실패했습니다.');
      setSnapshot(data.snapshot);
      setMessage('쿠폰 적용 완료! 뽑기권 100개가 추가되었습니다.');
      event.currentTarget.reset();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '쿠폰 적용에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  const ownedCount = snapshot.inventory.length;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#content">본문으로 건너뛰기</a>
      <header className="topbar">
        <button className="brand" onClick={() => setTab('home')}>LIMKETMON</button>
        <nav aria-label="주요 메뉴">
          {(['home', 'pull', 'collection', 'coupon'] as Tab[]).map((item) => (
            <button key={item} className={tab === item ? 'active' : ''} onClick={() => { setTab(item); setMessage(''); }}>
              {{ home: '홈', pull: '뽑기', collection: '도감', coupon: '쿠폰' }[item]}
            </button>
          ))}
        </nav>
      </header>

      <main id="content" className="page">
        {tab === 'home' && (
          <>
            <header className="hero">
              <h1>LIMKETMON</h1>
              <p>임신규 카드 도감</p>
            </header>
            <section className="panel status">
              <div className="who">
                <span>{user.displayName}</span>
                <a href="/signout-with-chatgpt?return_to=%2F">로그아웃</a>
              </div>
              <dl className="stats">
                <div><dt>오늘 무료 뽑기</dt><dd className={snapshot.freeAvailable ? 'ok' : ''}>{snapshot.freeAvailable ? '가능' : '완료'}</dd></div>
                <div><dt>뽑기권</dt><dd>{snapshot.credits}</dd></div>
                <div><dt>수집</dt><dd>{snapshot.completion}% <small>{ownedCount}/{cards.length}</small></dd></div>
              </dl>
              <div className="progress" role="progressbar" aria-label="도감 완성도" aria-valuenow={snapshot.completion} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ transform: `scaleX(${snapshot.completion / 100})` }} />
              </div>
            </section>
            <section className="actions">
              <button className="btn btn-primary" onClick={() => setTab('pull')}>카드팩 열기</button>
              <button className="btn" onClick={() => setTab('collection')}>도감 보기</button>
              <button className="btn" onClick={() => setTab('coupon')}>쿠폰 입력</button>
            </section>
          </>
        )}

        {tab === 'pull' && (
          <section className="pull-view">
            <h1>오늘의 카드팩</h1>
            <p className="muted">매일 자정(KST)에 무료 뽑기가 충전됩니다.</p>
            {result ? (
              <CardView card={result.card} quantity={result.quantity} onClick={() => setSelected(result.card)} featured />
            ) : (
              <div className="pack" aria-hidden="true"><span>L</span><b>LIMKETMON</b><small>MYSTERY CARD</small></div>
            )}
            {result && <p className="result-copy">{result.isNew ? 'NEW! 도감에 새 카드가 추가됐습니다.' : `중복 카드 · 보유 ×${result.quantity}`}</p>}
            <button className="btn btn-primary pull-button" disabled={busy} onClick={pull}>
              {busy ? '여는 중…' : result ? '한 번 더 뽑기' : snapshot.freeAvailable ? '무료로 열기' : `뽑기권 사용 (${snapshot.credits})`}
            </button>
            {message && <p className="notice error" role="alert">{message}</p>}
          </section>
        )}

        {tab === 'collection' && (
          <section>
            <header className="section-head">
              <h1>카드 도감</h1>
              <strong>{ownedCount}/{cards.length}</strong>
            </header>
            <div className="card-grid">
              {cards.map((card) => {
                const item = inventory.get(card.id);
                return item ? (
                  <CardView key={card.id} card={card} quantity={item.quantity} onClick={() => setSelected(card)} />
                ) : (
                  <div key={card.id} className="card locked" aria-label="미획득 카드"><span>?</span><small>NO. {String(card.version).padStart(3, '0')}</small></div>
                );
              })}
            </div>
          </section>
        )}

        {tab === 'coupon' && (
          <section className="coupon-view">
            <h1>쿠폰</h1>
            <p className="muted">쿠폰 코드는 계정당 한 번만 사용할 수 있습니다.</p>
            <form className="panel coupon-form" onSubmit={submitCoupon}>
              <label htmlFor="coupon">쿠폰 코드</label>
              <input id="coupon" className="field" name="code" autoComplete="off" placeholder="코드를 입력하세요" required />
              <button className="btn btn-primary" disabled={busy}>{busy ? '확인 중…' : '사용하기'}</button>
            </form>
            {message && <p className={`notice ${message.startsWith('쿠폰 적용') ? 'success' : 'error'}`} role="status">{message}</p>}
          </section>
        )}
      </main>

      {selected && <CardModal card={selected} quantity={inventory.get(selected.id)?.quantity ?? 0} onClose={() => setSelected(null)} />}
    </div>
  );
}

function CardView({ card, quantity, onClick, featured = false }: { card: Card; quantity: number; onClick: () => void; featured?: boolean }) {
  return (
    <button className={`card rarity-${card.rarity} ${featured ? 'featured' : ''}`} onClick={onClick}>
      <img src={`/cards/${card.imageKey}`} alt="" />
      <span className="rarity">{card.rarity}</span>
      <span className="card-name">{card.name}</span>
      {quantity > 1 && <b className="quantity">×{quantity}</b>}
    </button>
  );
}

function CardModal({ card, quantity, onClose }: { card: Card; quantity: number; onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className={`modal panel rarity-${card.rarity}`} role="dialog" aria-modal="true" aria-label={`${card.name} 상세`} onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="닫기">×</button>
        <img src={`/cards/${card.imageKey}`} alt={card.name} />
        <div className="modal-copy">
          <span className="rarity">{card.rarity}</span>
          <h2>{card.name}</h2>
          <p className="skill"><strong>{card.skillName}</strong><br />{card.skillDescription}</p>
          <p className="flavor">{card.flavorText}</p>
          <dl className="card-stats"><div><dt>ATK</dt><dd>{card.attack}</dd></div><div><dt>DEF</dt><dd>{card.defense}</dd></div><div><dt>LUCK</dt><dd>{card.luck}</dd></div></dl>
          <small>보유 ×{quantity}</small>
        </div>
      </section>
    </div>
  );
}
