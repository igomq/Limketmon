<script lang="ts">
	import Card from './Card.svelte';
	import RarityBadge from './RarityBadge.svelte';
	import type { CardDefinition } from '$lib/cards.ts';

	type Stage = 'idle' | 'shaking' | 'tearing' | 'back' | 'reveal';
	let {
		doPull,
		onexit
	}: {
		/** POSTs /api/pull; resolves with the result or throws */
		doPull: () => Promise<PullPayload>;
		onexit: () => void;
	} = $props();

	interface PullPayload {
		card: CardDefinition;
		isNew: boolean;
		quantity: number;
		usedFreePull: boolean;
		creditsRemaining: number;
	}

	let stage = $state<Stage>('idle');
	let result = $state<PullPayload | null>(null);
	let error = $state('');
	let busy = false;
	let timers: ReturnType<typeof setTimeout>[] = [];
	const later = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms));

	async function tap() {
		if (busy || stage !== 'idle') return;
		busy = true;
		error = '';
		stage = 'shaking';
		try {
			const p = await doPull();
			result = p;
		} catch (e) {
			stage = 'idle';
			error = e instanceof Error ? e.message : '뽑기에 실패했습니다.';
			busy = false;
			return;
		}
		later(() => (stage = 'tearing'), 700);
		later(() => (stage = 'back'), 1250);
		later(() => {
			stage = 'reveal';
			busy = false;
		}, 1900);
	}

	function again() {
		timers.forEach(clearTimeout);
		timers = [];
		result = null;
		stage = 'idle';
	}

	$effect(() => {
		return () => timers.forEach(clearTimeout);
	});
</script>

<div class="pack-stage stage-{stage}">
	{#if stage === 'idle' || stage === 'shaking' || stage === 'tearing'}
		<button class="pack" class:shaking={stage === 'tearing'} class:wobbling={stage === 'shaking'} onclick={tap} aria-label="카드팩 열기">
			<div class="pack-face">
				<div class="pack-logo">LIMKETMON</div>
				<div class="pack-sub">TRADING CARD GAME</div>
				<div class="pack-art" aria-hidden="true">★</div>
				<div class="pack-foot">1 CARD INSIDE</div>
			</div>
			<div class="pack-shine"></div>
		</button>
		<p class="hint">{stage === 'idle' ? '탭해서 열기' : '…'}</p>
		{#if error}<p class="form-error" role="alert">{error}</p>{/if}
	{:else if stage === 'back'}
		<div class="flash" aria-hidden="true"></div>
		<div class="cardback"><div class="back-pattern">LIMKETMON</div></div>
	{:else if stage === 'reveal' && result}
		<div class="reveal">
			<div class="burst r-{result.card.rarity}" aria-hidden="true"></div>
			<div class="reveal-card">
				<Card card={result.card} />
			</div>
			<div class="reveal-info">
				<RarityBadge rarity={result.card.rarity} />
				{#if result.isNew}
					<span class="new-badge">NEW!</span>
				{:else}
					<span class="dup-badge">×{result.quantity}</span>
				{/if}
				<p class="hint">{result.usedFreePull ? '오늘의 무료 뽑기 사용' : `남은 뽑기권 ${result.creditsRemaining}`}</p>
			</div>
			<div class="row">
				<button class="btn btn-primary" onclick={again}>다시 뽑기</button>
				<button class="btn" onclick={onexit}>도감 보기</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.pack-stage {
		display: grid;
		place-items: center;
		gap: 20px;
		min-height: 60vh;
		padding: 24px 0;
	}

	/* --- pack --- */
	.pack {
		position: relative;
		width: min(58vw, 250px);
		aspect-ratio: 5 / 7;
		border: none;
		padding: 0;
		cursor: pointer;
		border-radius: 16px;
		background: none;
		perspective: 800px;
		transition: transform 200ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
	}
	.pack:active { transform: scale(0.96); }
	.pack-face {
		position: absolute;
		inset: 0;
		border-radius: 16px;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: space-between;
		padding: 26px 14px;
		background:
			radial-gradient(140% 100% at 50% 0%, rgba(232, 182, 76, 0.35), transparent 55%),
			linear-gradient(165deg, #23232c, #131318 70%);
		border: 1px solid rgba(232, 182, 76, 0.55);
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 30px rgba(232, 182, 76, 0.18);
	}
	.pack-logo {
		font-weight: 900;
		letter-spacing: 0.18em;
		color: var(--gold-hi);
		font-size: 1.15rem;
	}
	.pack-sub {
		font-size: 0.55rem;
		letter-spacing: 0.34em;
		color: var(--text-dim);
		margin-top: 4px;
	}
	.pack-art {
		font-size: 4rem;
		color: var(--accent);
		text-shadow: 0 0 30px rgba(232, 182, 76, 0.7);
	}
	.pack-foot {
		font-size: 0.6rem;
		letter-spacing: 0.3em;
		color: var(--text-dim);
	}
	.pack-shine {
		position: absolute;
		inset: 0;
		border-radius: 16px;
		background: linear-gradient(115deg, transparent 30%, rgba(255, 255, 255, 0.14) 45%, transparent 60%);
		background-size: 250% 250%;
		animation: sweep 3.5s ease-in-out infinite;
		pointer-events: none;
	}
	@keyframes sweep {
		0%, 100% { background-position: 120% 0; }
		50% { background-position: -40% 0; }
	}

	.pack.wobbling { animation: wobble 350ms ease-in-out infinite; }
	@keyframes wobble {
		0%, 100% { transform: rotate(-2.4deg); }
		50% { transform: rotate(2.4deg) scale(1.015); }
	}
	.pack.shaking {
		animation: shake 550ms cubic-bezier(0.36, 0.07, 0.19, 0.97);
	}
	@keyframes shake {
		10%, 90% { transform: translate(-2px, -1px) rotate(-1deg); }
		30%, 70% { transform: translate(4px, 2px) rotate(1.5deg); }
		50% { transform: translate(-6px, 1px) rotate(-2deg) scale(1.04); }
		100% { transform: scale(1.12); opacity: 0; filter: brightness(2); }
	}

	.hint { color: var(--text-dim); font-size: 0.85rem; margin: 0; letter-spacing: 0.04em; }

	/* --- tear flash + card back --- */
	.flash {
		position: fixed;
		inset: 0;
		background: white;
		z-index: 60;
		pointer-events: none;
		animation: flash-out 450ms ease-out forwards;
	}
	@keyframes flash-out {
		from { opacity: 0.9; }
		to { opacity: 0; }
	}
	.cardback {
		width: min(58vw, 250px);
		aspect-ratio: 5 / 7;
		border-radius: 12px;
		background: linear-gradient(165deg, #26262f, #131318);
		border: 1px solid var(--line);
		display: grid;
		place-items: center;
		animation: back-in 400ms cubic-bezier(0.2, 0.9, 0.3, 1.1);
	}
	@keyframes back-in {
		from { transform: scale(0.6); opacity: 0; }
	}
	.back-pattern {
		font-weight: 900;
		letter-spacing: 0.3em;
		font-size: 0.75rem;
		color: rgba(232, 182, 76, 0.4);
	}

	/* --- reveal --- */
	.reveal {
		display: grid;
		justify-items: center;
		gap: 16px;
		animation: reveal-in 480ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
	}
	@keyframes reveal-in {
		from { transform: rotateY(90deg) scale(0.8); opacity: 0; }
	}
	.reveal-card {
		width: min(64vw, 290px);
	}
	.burst {
		position: absolute;
		width: 1px; height: 1px;
		border-radius: 50%;
		pointer-events: none;
	}
	.reveal { position: relative; }
	.burst::before {
		content: '';
		position: absolute;
		left: 50%; top: 40%;
		width: 70vmin; height: 70vmin;
		transform: translate(-50%, -50%);
		border-radius: 50%;
		background: radial-gradient(circle, var(--burst, rgba(232,182,76,.35)), transparent 60%);
		animation: burst 900ms ease-out forwards;
	}
	.burst.r-N { --burst: rgba(168,168,180,.15); }
	.burst.r-R { --burst: rgba(111,177,224,.25); }
	.burst.r-SR { --burst: rgba(177,127,224,.32); }
	.burst.r-SSR { --burst: rgba(232,182,76,.4); }
	.burst.r-UR { --burst: rgba(255,122,69,.5); }
	@keyframes burst {
		from { transform: translate(-50%, -50%) scale(0.2); opacity: 1; }
		to { transform: translate(-50%, -50%) scale(1.6); opacity: 0; }
	}

	.reveal-info {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		justify-content: center;
	}
	.new-badge {
		background: linear-gradient(180deg, var(--gold-hi), var(--accent));
		color: #241a05;
		font-weight: 900;
		padding: 4px 12px;
		border-radius: 999px;
		font-size: 0.8rem;
		letter-spacing: 0.06em;
	}
	.dup-badge {
		border: 1px solid var(--line);
		color: var(--text);
		font-weight: 800;
		padding: 4px 12px;
		border-radius: 999px;
		font-size: 0.8rem;
	}
	.row { display: flex; gap: 10px; }

	@media (prefers-reduced-motion: reduce) {
		.pack-shine, .pack.wobbling, .burst::before { animation: none; }
		.pack.shaking { animation-duration: 150ms; }
	}
</style>
