'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Card } from '../lib/cards';
import { cardTitle } from '../lib/collection';
import type { DeckSummary } from '../lib/battle/api';
import { DECK_NAME_MAX, DECK_SIZE, MAX_DECKS, validateDeck } from '../lib/decks';
import { CardArtwork, Icon, spring } from './card-ui';
import './battle.css';

type User = { email: string; displayName: string } | null;

type DeckViewProps = {
  user: User;
  decks: DeckSummary[];
  ownedCardIds: string[];
  cards: Card[];
  busy: boolean;
  onDecksChange: (decks: DeckSummary[]) => void;
  onOpenCard: (card: Card) => void;
  onError: (message: string) => void;
};

const signInHref = `/signin-with-chatgpt?return_to=${encodeURIComponent('/#deck')}`;

export function DeckView({ user, decks, ownedCardIds, cards, busy, onDecksChange, onOpenCard, onError }: DeckViewProps) {
  const byId = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  const owned = useMemo(() => new Set(ownedCardIds), [ownedCardIds]);
  const ownedCards = useMemo(
    () => ownedCardIds.reduce<Card[]>((list, id) => { const card = byId.get(id); if (card) list.push(card); return list; }, []),
    [ownedCardIds, byId]
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [pick, setPick] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const working = busy || pending !== null;
  const editing = decks.find((deck) => deck.id === editingId) ?? null;
  const dirty = !!editing && (draft.length !== editing.cards.length || draft.some((id, index) => id !== editing.cards[index]));
  const check = validateDeck(draft, owned);
  const pickCheck = validateDeck(pick, owned);

  useEffect(() => {
    if (decks.some((deck) => deck.id === editingId)) return;
    const next = decks.find((deck) => deck.isDefault) ?? decks[0] ?? null;
    setEditingId(next?.id ?? null);
    setDraft(next?.cards ?? []);
  }, [decks, editingId]);

  async function request(body: Record<string, unknown>): Promise<DeckSummary[] | null> {
    setPending(String(body.action));
    try {
      const response = await fetch('/api/deck', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await response.json() as { decks?: DeckSummary[]; error?: string };
      if (!response.ok || !Array.isArray(data.decks)) {
        onError(data.error || '덱을 저장하지 못했어요. 잠시 후 다시 시도해주세요.');
        return null;
      }
      onDecksChange(data.decks);
      return data.decks;
    } catch {
      onError('연결을 확인한 뒤 다시 시도해주세요.');
      return null;
    } finally {
      setPending(null);
    }
  }

  function select(deck: DeckSummary) {
    setEditingId(deck.id);
    setDraft(deck.cards);
    setRenamingId(null);
    setConfirmId(null);
  }

  function startCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newName.trim();
    if (!name || working || decks.length >= MAX_DECKS) return;
    setCreating(name);
    setNewName('');
    setPick([]);
    setPicking(true);
  }

  /** The picker commits: a new deck is created from these cards, or an existing deck is edited. */
  async function applyPick() {
    if (creating) {
      const next = await request({ action: 'create', name: creating, cardIds: pick });
      // A rejected create (duplicate name, cap reached) must hand the name back, or the picker
      // traps the player with an error they cannot fix.
      if (!next) {
        setNewName(creating);
        setCreating(null);
        setPicking(false);
        return;
      }
      const made = next.find((deck) => deck.name === creating) ?? next[next.length - 1];
      setCreating(null);
      setPicking(false);
      if (made) select(made);
      return;
    }
    setDraft(pick);
    setPicking(false);
  }

  /** Fills the selected deck (or a new one) with the strongest owned cards. */
  async function autoFill() {
    if (working) return;
    const next = await request({ action: 'auto', deckId: editingId ?? undefined });
    if (!next) return;
    const filled = next.find((deck) => deck.id === editingId) ?? next[next.length - 1];
    if (filled) select(filled);
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = renameValue.trim();
    if (!editing || !name) return;
    const next = await request({ action: 'rename', deckId: editing.id, name });
    if (next) setRenamingId(null);
  }

  async function save() {
    if (!editing) return;
    const next = await request({ action: 'save', deckId: editing.id, cardIds: draft });
    const saved = next?.find((deck) => deck.id === editing.id);
    if (saved) setDraft(saved.cards);
  }

  async function remove(deck: DeckSummary) {
    const next = await request({ action: 'delete', deckId: deck.id });
    setConfirmId(null);
    if (!next || next.some((item) => item.id === deck.id)) return;
    const fallback = next.find((item) => item.isDefault) ?? next[0] ?? null;
    setEditingId(fallback?.id ?? null);
    setDraft(fallback?.cards ?? []);
  }

  function openPicker() {
    setPick(draft);
    setPicking(true);
  }

  function toggle(cardId: string) {
    setPick((current) => current.includes(cardId)
      ? current.filter((id) => id !== cardId)
      : current.length >= DECK_SIZE ? current : [...current, cardId]);
  }

  return (
    <section className="deck-view" aria-labelledby="deck-title">
      <header className="section-head">
        <div>
          <p className="eyebrow">DECK BUILDER</p>
          <h1 id="deck-title">전투 덱.</h1>
          <p>{user ? '보유한 카드 3장이 한 덱. 기본 덱은 전투에서 자동으로 선택됩니다.' : '로그인하면 내 카드로 전투 덱을 만들 수 있어요.'}</p>
        </div>
        {user && <span className="deck-cap">{decks.length}<small>/ {MAX_DECKS} 덱</small></span>}
      </header>

      {!user ? (
        <section className="welcome-strip">
          <span><Icon name="sparkle" /><strong>전투 덱은 로그인 후에.</strong><span>덱을 만들면 바로 대련을 걸 수 있어요.</span></span>
          <a href={signInHref}>ChatGPT로 시작하기<Icon name="arrow" /></a>
        </section>
      ) : (
        <>
          <form className="deck-create" onSubmit={startCreate}>
            <label htmlFor="new-deck-name">새 덱 이름</label>
            <div className="deck-create-row">
              <input
                id="new-deck-name"
                name="name"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                maxLength={DECK_NAME_MAX}
                placeholder="예: 셋이서 한 팀"
                autoComplete="off"
                disabled={working || decks.length >= MAX_DECKS}
              />
              <button className="btn btn-dark" disabled={working || !newName.trim() || decks.length >= MAX_DECKS}>덱 만들기</button>
            </div>
            <div className="deck-auto-row">
              <button type="button" className="text-button" onClick={() => void autoFill()} disabled={working || ownedCardIds.length < DECK_SIZE}>
                <Icon name="sparkle" />{editingId ? '고른 덱을 추천 카드로 채우기' : '추천 덱 만들기'}
              </button>
            </div>
            <p className="deck-note" role="status">
              {decks.length >= MAX_DECKS ? `덱은 최대 ${MAX_DECKS}개까지 만들 수 있어요.` : '이름을 넣고 덱 만들기를 누르면 보유 카드 3장을 고르는 창이 열려요.'}
            </p>
          </form>

          {decks.length ? (
            <ul className="deck-list" aria-label="내 덱">
              {decks.map((deck) => {
                const legal = deck.cards.length === DECK_SIZE;
                return (
                  <li key={deck.id} className={`deck-row ${deck.id === editingId ? 'is-editing' : ''}`}>
                    <button className="deck-pick" aria-pressed={deck.id === editingId} onClick={() => select(deck)}>
                      <strong className="deck-name">{deck.name}</strong>
                      <span className="deck-meta">
                        {deck.isDefault && <span className="deck-badge">기본 덱</span>}
                        <span>카드 {deck.cards.length}장</span>
                        {!legal && <span className="deck-warn">전투하려면 3장 필요</span>}
                      </span>
                    </button>
                    <div className="deck-row-actions">
                      {renamingId === deck.id ? (
                        <form className="deck-rename" onSubmit={rename}>
                          <input
                            value={renameValue}
                            onChange={(event) => setRenameValue(event.target.value)}
                            maxLength={DECK_NAME_MAX}
                            aria-label={`${deck.name} 새 이름`}
                            autoComplete="off"
                          />
                          <button className="btn btn-primary" disabled={working || !renameValue.trim()}>저장</button>
                          <button type="button" className="text-button" onClick={() => setRenamingId(null)}>취소</button>
                        </form>
                      ) : confirmId === deck.id ? (
                        <>
                          <span className="deck-confirm">이 덱을 삭제할까요?</span>
                          <button className="text-button danger" disabled={working} onClick={() => void remove(deck)}>삭제</button>
                          <button className="text-button" onClick={() => setConfirmId(null)}>취소</button>
                        </>
                      ) : (
                        <>
                          <button className="text-button" onClick={() => { setRenamingId(deck.id); setRenameValue(deck.name); }}>이름 변경</button>
                          <button className="text-button" disabled={deck.isDefault || working} onClick={() => void request({ action: 'setDefault', deckId: deck.id })}>기본 덱 지정</button>
                          <button className="text-button danger" disabled={working} onClick={() => setConfirmId(deck.id)}>삭제</button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="deck-empty">아직 덱이 없어요. 위에서 첫 덱을 만들어 주세요.</p>
          )}

          {editing && (
            <section className="deck-editor" aria-labelledby="deck-editor-title">
              <div className="deck-editor-head">
                <h2 id="deck-editor-title">{editing.name}</h2>
                <p className="deck-hint" role="status">
                  <Icon name={check.ok ? 'check' : 'clock'} />
                  {check.ok ? '지금 그대로 전투에 쓸 수 있어요.' : check.error}
                </p>
              </div>
              <ol className="deck-slots">
                {Array.from({ length: DECK_SIZE }, (_, index) => {
                  const cardId = draft[index];
                  const card = cardId ? byId.get(cardId) : undefined;
                  return (
                    <li key={index} className={`deck-slot ${card ? '' : 'is-empty'}`}>
                      <span className="slot-index" aria-hidden="true">{index + 1}</span>
                      {card ? (
                        <>
                          <div className="slot-art"><CardArtwork card={card} /></div>
                          <p className="slot-name">{cardTitle(card)}</p>
                          <div className="slot-actions">
                            <button className="text-button" onClick={() => onOpenCard(card)}>정보</button>
                            <button className="text-button danger" onClick={() => setDraft((current) => current.filter((_, position) => position !== index))}>빼기</button>
                          </div>
                        </>
                      ) : (
                        <button className="slot-empty" onClick={openPicker}>+ 카드 넣기</button>
                      )}
                    </li>
                  );
                })}
              </ol>
              <div className="sticky-bar deck-save-bar">
                <span className="deck-save-state" role="status">
                  <Icon name={dirty ? 'clock' : 'check'} />
                  {dirty ? '저장하지 않은 변경사항이 있어요.' : '모든 변경사항을 저장했어요.'}
                </span>
                <button className="btn btn-primary" disabled={!dirty || !check.ok || working} onClick={() => void save()}>
                  {pending === 'save' ? '저장 중…' : '덱 저장'}
                </button>
              </div>
              <p className="deck-note">보유한 카드만 넣을 수 있고, 같은 카드를 두 번 넣을 수는 없어요.</p>
            </section>
          )}
        </>
      )}

      {picking && (
        <CardPicker
          cards={ownedCards}
          selected={pick}
          valid={pickCheck.ok}
          busy={working}
          confirmLabel={creating ? '이 카드로 덱 만들기' : '이 카드들로 정하기'}
          onToggle={toggle}
          onClose={() => { setPicking(false); if (creating) setNewName(creating); setCreating(null); }}
          onApply={() => void applyPick()}
        />
      )}
    </section>
  );
}

function CardPicker({ cards, selected, valid, busy, confirmLabel, onToggle, onClose, onApply }: {
  cards: Card[];
  selected: string[];
  valid: boolean;
  busy: boolean;
  confirmLabel: string;
  onToggle: (cardId: string) => void;
  onClose: () => void;
  onApply: () => void;
}) {
  const reduced = useReducedMotion();
  const dialog = useRef<HTMLDialogElement>(null);
  const full = selected.length >= DECK_SIZE;

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
      className="picker-dialog"
      aria-label="덱에 넣을 카드 고르기"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18 }}
    >
      <motion.section
        className="picker-sheet"
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={spring}
      >
        <button className="sheet-handle" aria-label="카드 고르기 닫기" onClick={onClose}><span /></button>
        <header className="picker-head">
          <div>
            <span className="eyebrow">MY CARDS</span>
            <h2>카드 {DECK_SIZE}장 고르기</h2>
          </div>
          <span className="picker-count" role="status">{selected.length}<small>/ {DECK_SIZE}</small></span>
        </header>
        <p className="picker-hint" role="status">
          {full ? '3장을 모두 골랐어요. 바꾸려면 먼저 골라둔 카드를 빼주세요.' : selected.length ? `${DECK_SIZE - selected.length}장 더 골라주세요.` : '보유한 카드에서 3장을 골라주세요.'}
        </p>
        {cards.length ? (
          <ul className="picker-grid">
            {cards.map((card) => {
              const index = selected.indexOf(card.id);
              const chosen = index >= 0;
              return (
                <li key={card.id} className={`picker-item ${chosen ? 'is-selected' : ''} ${!chosen && full ? 'is-blocked' : ''}`}>
                  <button
                    className="picker-pick"
                    aria-pressed={chosen}
                    aria-disabled={!chosen && full}
                    aria-label={`${cardTitle(card)}, ${chosen ? '덱에서 빼기' : '덱에 넣기'}`}
                    onClick={() => { if (!chosen && full) return; onToggle(card.id); }}
                  >
                    <CardArtwork card={card} />
                    {chosen && <span className="picker-order">{index + 1}</span>}
                    <span className="picker-check" aria-hidden="true"><Icon name={chosen ? 'check' : 'sparkle'} /></span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="picker-empty"><Icon name="search" /><p>아직 보유한 카드가 없어요. 카드팩을 먼저 열어주세요.</p></div>
        )}
        <footer className="picker-foot">
          <button className="btn btn-dark" onClick={onClose}>취소</button>
          <button className="btn btn-primary" disabled={!valid || busy} onClick={onApply}>{busy ? '저장 중…' : confirmLabel}</button>
        </footer>
      </motion.section>
    </motion.dialog>
  );
}
