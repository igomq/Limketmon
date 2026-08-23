<script lang="ts">
	import { onMount } from 'svelte';
	import { toPng } from 'html-to-image';
	import Card from './Card.svelte';
	import RarityBadge from './RarityBadge.svelte';
	import { resolveCardImage, type CardDefinition } from '$lib/cards.ts';

	let {
		card,
		quantity = null,
		onclose
	}: {
		card: CardDefinition;
		quantity?: number | null;
		onclose: () => void;
	} = $props();

	let dialog = $state<HTMLDivElement | null>(null);
	let closeButton = $state<HTMLButtonElement | null>(null);
	let cardExport = $state<HTMLDivElement | null>(null);
	let storyExport = $state<HTMLDivElement | null>(null);
	let closing = $state(false);
	let shareState = $state<'idle' | 'working' | 'done' | 'error'>('idle');
	let shareLabel = $state('');
	let closeTimer: ReturnType<typeof setTimeout> | null = null;

	onMount(() => {
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const scrollY = window.scrollY;
		const previousBody = {
			position: document.body.style.position,
			top: document.body.style.top,
			width: document.body.style.width,
			overflow: document.body.style.overflow
		};

		document.body.style.position = 'fixed';
		document.body.style.top = `-${scrollY}px`;
		document.body.style.width = '100%';
		document.body.style.overflow = 'hidden';
		closeButton?.focus();

		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				requestClose();
				return;
			}
			if (event.key !== 'Tab' || !dialog) return;
			const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')];
			if (!focusable.length) return;
			const first = focusable[0]!;
			const last = focusable.at(-1)!;
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};

		window.addEventListener('keydown', onKey);
		return () => {
			if (closeTimer) clearTimeout(closeTimer);
			window.removeEventListener('keydown', onKey);
			Object.assign(document.body.style, previousBody);
			window.scrollTo(0, scrollY);
			previousFocus?.focus();
		};
	});

	function requestClose() {
		if (closing) return;
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
			onclose();
			return;
		}
		closing = true;
		closeTimer = setTimeout(onclose, 180);
	}

	function download(blob: Blob, filename: string) {
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = filename;
		document.body.append(anchor);
		anchor.click();
		anchor.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1_000);
	}

	async function exportImage(kind: 'card' | 'story') {
		const node = kind === 'card' ? cardExport : storyExport;
		if (!node) throw new Error('export target missing');
		const dataUrl = await toPng(node, {
			pixelRatio: 2,
			cacheBust: true,
			backgroundColor: '#0d0d11'
		});
		return await (await fetch(dataUrl)).blob();
	}

	async function share(kind: 'card' | 'story') {
		if (shareState === 'working') return;
		shareState = 'working';
		shareLabel = kind === 'card' ? '카드 이미지' : '스토리';
		try {
			const blob = await exportImage(kind);
			const filename = `limketmon-${card.id}-${kind}.png`;
			const file = new File([blob], filename, { type: 'image/png' });
			if (navigator.canShare?.({ files: [file] })) {
				try {
					await navigator.share({
						files: [file],
						title: `${card.name} · LIMKETMON`,
						text: `${card.rarity} ${card.name}`
					});
				} catch (error) {
					if ((error as Error).name === 'AbortError') {
						shareState = 'idle';
						return;
					}
					download(blob, filename);
				}
			} else {
				download(blob, filename);
			}
			shareState = 'done';
		} catch {
			shareState = 'error';
		}
	}
</script>

<div
	class="overlay"
	class:closing
	role="presentation"
	onclick={(event) => event.target === event.currentTarget && requestClose()}
>
	<div
		class="dialog"
		bind:this={dialog}
		role="dialog"
		aria-modal="true"
		aria-labelledby="card-dialog-title"
		aria-describedby="card-dialog-description"
	>
		<button class="close" bind:this={closeButton} onclick={requestClose} aria-label="카드 상세 닫기">
			<svg viewBox="0 0 24 24" aria-hidden="true">
				<path d="M6 6l12 12M18 6 6 18" />
			</svg>
		</button>

		<div class="showcase">
			<div class="aura rarity-{card.rarity}" aria-hidden="true"></div>
			<div class="card-wrap"><Card {card} {quantity} effect="full" /></div>
		</div>

		<div class="details">
			<RarityBadge rarity={card.rarity} />
			<h2 id="card-dialog-title">{card.name}</h2>
			<p id="card-dialog-description" class="flavor">{card.flavorText}</p>
		</div>

		<div class="actions">
			<button class="btn btn-primary" onclick={() => share('card')} disabled={shareState === 'working'}>
				{shareState === 'working' && shareLabel === '카드 이미지' ? '이미지 생성 중…' : '카드 이미지'}
			</button>
			<button class="btn" onclick={() => share('story')} disabled={shareState === 'working'}>
				{shareState === 'working' && shareLabel === '스토리' ? '이미지 생성 중…' : '스토리 공유'}
			</button>
		</div>

		<p class="feedback" class:error={shareState === 'error'} aria-live="polite">
			{shareState === 'done' ? `${shareLabel} 준비 완료` : shareState === 'error' ? '이미지 생성에 실패했습니다. 다시 시도해 주세요.' : ''}
		</p>
	</div>
</div>

<div class="exports" aria-hidden="true">
	<div class="card-export" bind:this={cardExport}>
		<Card {card} {quantity} effect="static" />
	</div>

	<div
		class="story-export"
		bind:this={storyExport}
		style:background-image={`linear-gradient(rgba(7,7,10,.34), rgba(7,7,10,.82)), url("${resolveCardImage(card.imageKey)}")`}
	>
		<div class="story-brand">LIMKETMON</div>
		<div class="story-card"><Card {card} {quantity} effect="static" /></div>
		<div class="story-copy">
			<strong>{card.rarity}</strong>
			<span>{card.name}</span>
		</div>
	</div>
</div>

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		place-items: center;
		overflow-y: auto;
		padding: max(18px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(18px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
		background: rgba(6, 6, 9, 0.74);
		backdrop-filter: blur(24px) saturate(125%);
		-webkit-backdrop-filter: blur(24px) saturate(125%);
		animation: overlay-in 220ms ease-out both;
	}

	.dialog {
		position: relative;
		width: min(100%, 430px);
		display: grid;
		justify-items: center;
		gap: 16px;
		padding: 18px 18px 16px;
		border-radius: 20px;
		background: rgba(15, 15, 20, 0.9);
		box-shadow: 0 30px 90px rgba(0,0,0,.68);
		animation: dialog-in 360ms cubic-bezier(.16,1,.3,1) both;
	}

	.overlay.closing { animation: overlay-out 180ms ease-in both; }
	.overlay.closing .dialog { animation: dialog-out 180ms ease-in both; }
	@keyframes overlay-in { from { opacity: 0; backdrop-filter: blur(0); } }
	@keyframes dialog-in { from { opacity: .2; transform: translateY(18px) scale(.91); filter: blur(7px); } }
	@keyframes overlay-out { to { opacity: 0; backdrop-filter: blur(0); } }
	@keyframes dialog-out { to { opacity: 0; transform: translateY(12px) scale(.96); } }

	.close {
		position: absolute;
		top: 12px;
		right: 12px;
		z-index: 4;
		width: 44px;
		height: 44px;
		display: grid;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: rgba(8,8,12,.72);
		color: var(--text);
		cursor: pointer;
		backdrop-filter: blur(12px);
	}
	.close svg { width: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
	.close:active { transform: scale(.92); }

	.showcase {
		position: relative;
		width: min(68vw, 302px);
		margin-top: 7px;
	}
	.aura {
		position: absolute;
		inset: 10%;
		border-radius: 50%;
		background: rgba(168,168,180,.24);
		filter: blur(34px);
		transform: scale(1.12);
	}
	.aura.rarity-R { background: rgba(111,177,224,.28); }
	.aura.rarity-SR { background: rgba(177,127,224,.34); }
	.aura.rarity-SSR { background: conic-gradient(#ffd56b, #ff8fcf, #8bdcff, #a3ffca, #ffd56b); opacity: .42; }
	.aura.rarity-UR { background: conic-gradient(#ff7a45, #ffd56b, #8bdcff, #d69cff, #ff7a45); opacity: .54; transform: scale(1.3); }
	.card-wrap { position: relative; z-index: 1; }

	.details { display: grid; justify-items: center; gap: 7px; text-align: center; }
	h2 { max-width: 26ch; font-size: 1.05rem; line-height: 1.25; text-wrap: balance; }
	.flavor { max-width: 38ch; margin: 0; color: var(--text-dim); font-size: .84rem; line-height: 1.5; }
	.actions { display: flex; justify-content: center; gap: 9px; }
	.actions .btn { min-height: 44px; padding-inline: 16px; font-size: .9rem; }
	.feedback { min-height: 1.25em; margin: -5px 0 0; color: var(--accent); font-size: .78rem; text-align: center; }
	.feedback.error { color: var(--danger); }

	.exports {
		position: fixed;
		left: -10000px;
		top: 0;
		pointer-events: none;
	}
	.card-export { width: 360px; height: 504px; background: #0d0d11; }
	.story-export {
		position: relative;
		isolation: isolate;
		width: 540px;
		height: 960px;
		display: grid;
		place-items: center;
		align-content: center;
		gap: 38px;
		overflow: hidden;
		background-color: #0d0d11;
		background-position: center;
		background-size: cover;
	}
	.story-export::before {
		content: '';
		position: absolute;
		inset: -30px;
		z-index: -1;
		background: inherit;
		filter: blur(28px) saturate(.82);
		transform: scale(1.08);
	}
	.story-brand { color: #f3c566; font-size: 20px; font-weight: 950; letter-spacing: .26em; }
	.story-card { width: 300px; }
	.story-copy { width: 430px; display: grid; gap: 8px; color: white; text-align: center; }
	.story-copy strong { color: #f3c566; font-size: 18px; letter-spacing: .16em; }
	.story-copy span { font-size: 24px; font-weight: 850; letter-spacing: -.02em; }

	@media (max-height: 680px) {
		.dialog { grid-template-columns: minmax(170px, 240px) 1fr; align-items: center; width: min(100%, 660px); }
		.showcase { grid-row: 1 / span 3; width: min(34vw, 230px); }
		.details, .actions, .feedback { grid-column: 2; }
	}

	@media (prefers-reduced-motion: reduce) {
		.overlay,
		.dialog,
		.overlay.closing,
		.overlay.closing .dialog { animation: none; }
	}
	@media (prefers-reduced-transparency: reduce) {
		.overlay { background: rgba(6,6,9,.94); backdrop-filter: none; }
		.dialog { background: #111116; }
	}
</style>
