'use client';

import { motion, useDragControls, useMotionTemplate, useMotionValue, useReducedMotion, useSpring, animate } from 'motion/react';
import { useEffect, useId, useRef, type PointerEvent, type ReactNode } from 'react';
import type { Card } from '../lib/cards';
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

export function CardArtwork({ card, quantity = 0, priority = false }: { card: Card; quantity?: number; priority?: boolean }) {
  const reduced = useReducedMotion();
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
      className={`card-art rarity-${card.rarity}`}
      style={{ rotateX: rx, rotateY: ry, transformPerspective: 900 }}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); move(event); }} onPointerMove={move} onPointerLeave={reset} onPointerUp={reset} onPointerCancel={reset}
    >
      <img src={`/cards/${card.imageKey}`} alt={cardTitle(card)} loading={priority ? 'eager' : 'lazy'} fetchPriority={priority ? 'high' : undefined} decoding="async" draggable={false} />
      <div className="card-shade" />
      <span className="card-edition">LIMKETMON <span>ORIGINALS</span></span>
      <span className="card-rarity">{card.rarity}<Icon name="sparkle" /></span>
      <div className="card-caption"><span>No. {String(card.version).padStart(3, '0')}</span><strong>{cardTitle(card)}</strong><small>{card.skillName}</small></div>
      {quantity > 1 && <span className="card-quantity">×{quantity}</span>}
      <motion.div className="card-foil" style={{ opacity: light, backgroundPosition: position }} />
      <motion.div className="card-glare" style={{ opacity: light, backgroundImage: glare }} />
      <span className="card-frame" />
    </motion.div>
  );
}

export function CardButton({ card, quantity = 0, onClick, priority = false }: { card: Card; quantity?: number; onClick: () => void; priority?: boolean }) {
  const reduced = useReducedMotion();
  return <motion.button className="card-button" onClick={onClick} aria-label={`${cardTitle(card)}, ${card.rarity}, ${quantity ? `보유 ${quantity}장` : '카드 미리보기'}`} whileHover={reduced ? undefined : { y: -5 }} whileTap={reduced ? undefined : { scale: 0.97 }} transition={spring}><CardArtwork card={card} quantity={quantity} priority={priority} /></motion.button>;
}

export function CardBack({ count = 1 }: { count?: number }) {
  return <div className="card-back"><div className="back-top"><span>100% LIM SINGYU</span><span>VOL. 01</span></div><div className="back-center"><Brand /><span>또 너냐, 임신규.</span></div><div className="back-bottom"><span>{count === 5 ? 'FIVE CARDS' : 'ONE CARD'}<br />열어도 임신규. 또 열어도 임신규.</span><Icon name="sparkle" /></div></div>;
}

export function CardDetail({ card, quantity, obtainedAt, onClose }: { card: Card; quantity: number; obtainedAt?: string; onClose: () => void }) {
  const reduced = useReducedMotion();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const drag = useDragControls();
  const y = useMotionValue(0);
  const dragged = useRef(false);

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
      <motion.section
        className={`detail-sheet rarity-${card.rarity}`} style={{ y }} drag={reduced ? false : 'y'} dragControls={drag} dragListener={false} dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0.05, bottom: 0.6 }} dragTransition={{ bounceStiffness: 360, bounceDamping: 34 }}
        onDragStart={() => { dragged.current = true; }} onDragEnd={(_, info) => { if (info.velocity.y >= 0 && projectedPosition(y.get(), info.velocity.y) > 140) onClose(); else animate(y, 0, { ...spring, velocity: info.velocity.y }); }}
        initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }} transition={spring}
      >
        <button className="sheet-handle" aria-label="아래로 끌어 닫기, 또는 눌러 닫기" onPointerDown={(event) => { dragged.current = false; drag.start(event); }} onClick={(event) => { if (!dragged.current || event.detail === 0) onClose(); }}><span /></button>
        <button className="icon-button detail-close" autoFocus onClick={onClose} aria-label="카드 상세 닫기"><Icon name="close" /></button>
        <div className="detail-art"><CardArtwork card={card} quantity={quantity} priority /><p><Icon name="hand" />카드에 손을 대고 빛을 움직여 보세요</p></div>
        <div className="detail-copy"><div className="detail-meta"><span className={`rarity-tag rarity-${card.rarity}`}>{card.rarity}</span><span>NO. {String(card.version).padStart(3, '0')} / ORIGINALS</span></div>
          <h2 id={titleId}>{cardTitle(card)}</h2><p className="detail-name">{card.name}</p>
          <div className="skill-block"><span className="eyebrow">SPECIAL ABILITY</span><h3>{card.skillName}</h3><p>{card.skillDescription}</p></div>
          <blockquote>“{card.flavorText}”</blockquote>
          <dl className="card-stats">{[['공격', card.attack], ['방어', card.defense], ['행운', card.luck]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}<span>/ 100</span></dd><div className="stat-track" aria-hidden="true"><motion.i initial={{ scaleX: reduced ? Number(value) / 100 : 0 }} animate={{ scaleX: Number(value) / 100 }} transition={{ ...spring, delay: reduced ? 0 : 0.15 }} /></div></div>)}</dl>
          <div className="detail-ownership"><span>{quantity ? <><Icon name="check" />내 컬렉션 · {quantity}장 보유</> : '아직 발견하지 못한 카드'}</span>{obtainedAt && <small>{new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium' }).format(new Date(obtainedAt))} 첫 수집</small>}</div>
        </div>
      </motion.section>
    </motion.dialog>
  );
}
