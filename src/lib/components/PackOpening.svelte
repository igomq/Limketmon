<script lang="ts">
	import { onMount } from 'svelte';
	import Card from './Card.svelte';
	import RarityBadge from './RarityBadge.svelte';
	import type { CardDefinition, Rarity } from '$lib/cards.ts';

	type Stage = 'idle' | 'compress' | 'tear' | 'flash' | 'back' | 'reveal';
	let {
		doPull,
		onexit
	}: {
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

	const revealDelay: Record<Rarity, number> = { N: 900, R: 980, SR: 1_080, SSR: 1_280, UR: 1_480 };
	let stage = $state<Stage>('idle');
	let result = $state<PullPayload | null>(null);
	let error = $state('');
	let busy = $state(false);
	let ready = $state(false);
	let skipRequested = false;
	let timers: ReturnType<typeof setTimeout>[] = [];
	const later = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms));

	onMount(() => {
		ready = true;
	});

	function clearTimers() {
		timers.forEach(clearTimeout);
		timers = [];
	}

	function reveal() {
		clearTimers();
		stage = 'reveal';
		busy = false;
		if (result && ['SSR', 'UR'].includes(result.card.rarity)) navigator.vibrate?.(result.card.rarity === 'UR' ? [18, 35, 28] : 22);
	}

	async function openPack() {
		if (busy || stage !== 'idle') return;
		busy = true;
		error = '';
		skipRequested = false;
		stage = 'compress';

		try {
			result = await doPull();
		} catch (cause) {
			clearTimers();
			stage = 'idle';
			error = cause instanceof Error ? cause.message : '뽑기에 실패했습니다.';
			busy = false;
			return;
		}

		if (skipRequested || matchMedia('(prefers-reduced-motion: reduce)').matches) {
			reveal();
			return;
		}

		later(() => (stage = 'tear'), 170);
		later(() => (stage = 'flash'), 480);
		later(() => (stage = 'back'), 640);
		later(reveal, revealDelay[result.card.rarity]);
	}

	function skip() {
		if (!busy && stage === 'idle') return;
		skipRequested = true;
		if (result) reveal();
	}

	function again() {
		clearTimers();
		result = null;
		error = '';
		stage = 'idle';
	}

	$effect(() => clearTimers);
</script>

<section class="pack-stage stage-{stage}" aria-label="카드팩 개봉">
	<div class="announcer sr-only" aria-live="polite">
		{stage === 'idle' ? error : stage === 'reveal' && result ? `${result.card.rarity} ${result.card.name} 획득` : '카드팩 개봉 중'}
	</div>

	{#if ['idle', 'compress', 'tear', 'flash'].includes(stage)}
		<button
			class="pack"
			class:compress={stage === 'compress'}
			class:tearing={stage === 'tear' || stage === 'flash'}
			onclick={openPack}
			disabled={!ready || busy}
			aria-label="LIMKETMON 카드팩 열기"
		>
			<span class="seal top-seal" aria-hidden="true"></span>
			<span class="pack-face">
				<span class="pack-logo">LIMKETMON</span>
				<span class="pack-sub">TRADING CARD GAME</span>
				<span class="pack-mark" aria-hidden="true">
					<svg viewBox="0 0 100 100">
						<path d="M50 11 61 38l28 12-28 12-11 27-11-27L11 50l28-12Z" />
						<circle cx="50" cy="50" r="15" />
					</svg>
				</span>
				<span class="pack-foot">1 CARD · SERIES 01</span>
			</span>
			<span class="pack-glare" aria-hidden="true"></span>
			<span class="tear-line" aria-hidden="true"></span>
		</button>
		<p class="hint">{stage === 'idle' ? '팩을 눌러 개봉' : stage === 'compress' ? '봉인 해제 중' : 'OPEN'}</p>
		{#if error}<p class="form-error centered" role="alert">{error}</p>{/if}
	{:else if stage === 'back'}
		<div class="card-back" aria-label="카드 뒷면">
			<div class="back-orbit" aria-hidden="true"></div>
			<strong>LIMKETMON</strong>
			<span>TRADING CARD GAME</span>
		</div>
	{:else if stage === 'reveal' && result}
		<div class="reveal rarity-{result.card.rarity}">
			<div class="burst" aria-hidden="true"></div>
			<div class="rays" aria-hidden="true"></div>
			<div class="reveal-card">
				<Card card={result.card} effect="full" />
			</div>
			<div class="reveal-info">
				<RarityBadge rarity={result.card.rarity} />
				{#if result.isNew}
					<span class="new-badge">NEW</span>
				{:else}
					<span class="duplicate">보유 ×{result.quantity}</span>
				{/if}
				<p>{result.usedFreePull ? '오늘의 무료 뽑기 사용' : `남은 뽑기권 ${result.creditsRemaining}`}</p>
			</div>
			<div class="row">
				<button class="btn btn-primary" onclick={again}>다시 뽑기</button>
				<button class="btn" onclick={onexit}>도감에서 보기</button>
			</div>
		</div>
	{/if}

	{#if busy && stage !== 'reveal'}
		<button class="skip" onclick={skip}>연출 건너뛰기</button>
	{/if}
</section>

{#if stage === 'flash'}
	<div class="screen-flash" class:rare={result?.card.rarity === 'SSR' || result?.card.rarity === 'UR'} aria-hidden="true"></div>
{/if}

<style>
	.pack-stage {
		position: relative;
		min-height: min(66vh, 620px);
		display: grid;
		place-items: center;
		align-content: center;
		gap: 18px;
		padding: 24px 0 38px;
	}

	.pack {
		position: relative;
		width: min(62vw, 252px);
		aspect-ratio: 5 / 7;
		padding: 0;
		border: 0;
		border-radius: 17px;
		background: transparent;
		cursor: pointer;
		touch-action: manipulation;
		transition: transform 180ms cubic-bezier(.16,1,.3,1), filter 180ms ease-out;
	}
	.pack:not(:disabled):hover { transform: translateY(-4px) rotateX(2deg); }
	.pack:not(:disabled):active { transform: scale(.965) translateY(2px); }
	.pack:disabled { opacity: 1; cursor: default; }

	.pack-face {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: space-between;
		overflow: hidden;
		padding: 28px 15px 24px;
		border: 1px solid rgba(232,182,76,.56);
		border-radius: inherit;
		background:
			radial-gradient(120% 70% at 50% -10%, rgba(232,182,76,.36), transparent 62%),
			linear-gradient(154deg, #25242b, #101014 72%);
		box-shadow: 0 24px 62px rgba(0,0,0,.6), 0 9px 26px rgba(232,182,76,.18);
	}
	.pack-face::after {
		content: '';
		position: absolute;
		inset: 9px;
		border: 1px solid rgba(255,221,149,.16);
		border-radius: 11px;
		pointer-events: none;
	}
	.pack-logo { color: var(--gold-hi); font-size: 1.08rem; font-weight: 950; letter-spacing: .17em; text-indent: .17em; }
	.pack-sub { margin-top: -39px; color: var(--text-dim); font-size: .52rem; font-weight: 700; letter-spacing: .28em; text-indent: .28em; }
	.pack-mark { width: 92px; color: var(--accent); filter: drop-shadow(0 0 18px rgba(232,182,76,.45)); }
	.pack-mark svg { display: block; fill: none; stroke: currentColor; stroke-width: 2.2; }
	.pack-mark circle { stroke-width: 1.2; }
	.pack-foot { color: #a9a7af; font-size: .58rem; font-weight: 750; letter-spacing: .22em; text-indent: .22em; }

	.seal {
		position: absolute;
		left: 0;
		right: 0;
		z-index: 5;
		height: 13px;
		border-radius: 16px 16px 4px 4px;
		background: linear-gradient(180deg, #62512c, #28241e);
		border-bottom: 1px dashed rgba(255,232,181,.34);
	}
	.top-seal { top: 0; }
	.pack-glare {
		position: absolute;
		inset: 0;
		z-index: 4;
		border-radius: inherit;
		background: linear-gradient(112deg, transparent 26%, rgba(255,255,255,.18) 44%, transparent 61%);
		background-size: 260% 100%;
		animation: pack-sheen 3.4s ease-in-out infinite;
		pointer-events: none;
	}
	@keyframes pack-sheen { 0%, 100% { background-position: 120% 0; } 50% { background-position: -55% 0; } }

	.tear-line {
		position: absolute;
		left: 3px;
		right: 3px;
		top: 15px;
		z-index: 6;
		height: 2px;
		background: white;
		opacity: 0;
		box-shadow: 0 0 16px white;
	}
	.pack.compress { animation: compress 280ms cubic-bezier(.2,.9,.2,1) infinite alternate; }
	@keyframes compress { to { transform: scale(.975, 1.018) rotate(-1deg); filter: brightness(1.08); } }
	.pack.tearing .tear-line { animation: tear 300ms ease-out both; }
	.pack.tearing .top-seal { animation: seal-away 320ms cubic-bezier(.2,.8,.2,1) both; }
	@keyframes tear { 0% { clip-path: inset(0 100% 0 0); opacity: 1; } 100% { clip-path: inset(0); opacity: .9; } }
	@keyframes seal-away { to { transform: translate(24px,-28px) rotate(13deg); opacity: 0; } }

	.hint { margin: 0; color: var(--text-dim); font-size: .82rem; font-weight: 650; letter-spacing: .06em; }
	.centered { margin: -7px 0 0; text-align: center; }
	.skip {
		position: absolute;
		right: 0;
		bottom: 4px;
		min-height: 44px;
		padding: 8px 3px;
		border: 0;
		background: transparent;
		color: var(--text-dim);
		font-size: .78rem;
		text-decoration: underline;
		cursor: pointer;
	}

	.screen-flash {
		position: fixed;
		inset: 0;
		z-index: 90;
		pointer-events: none;
		background: #fff;
		animation: flash 360ms ease-out both;
	}
	.screen-flash.rare { background: radial-gradient(circle, white 0 16%, #ffeab2 32%, rgba(163,218,255,.85) 58%, transparent 78%); }
	@keyframes flash { from { opacity: .9; } to { opacity: 0; } }

	.card-back {
		width: min(62vw, 252px);
		aspect-ratio: 5 / 7;
		display: grid;
		place-items: center;
		align-content: center;
		gap: 8px;
		overflow: hidden;
		border: 1px solid rgba(232,182,76,.45);
		border-radius: 13px;
		background: radial-gradient(circle at 50%, #28251e, #121216 62%);
		box-shadow: 0 24px 60px rgba(0,0,0,.6);
		animation: back-in 380ms cubic-bezier(.16,1,.3,1) both;
	}
	.card-back strong { z-index: 1; color: var(--accent); font-size: .84rem; letter-spacing: .24em; text-indent: .24em; }
	.card-back span { z-index: 1; color: var(--text-dim); font-size: .46rem; letter-spacing: .24em; text-indent: .24em; }
	.back-orbit { position: absolute; width: 145px; aspect-ratio: 1; border: 1px solid rgba(232,182,76,.28); border-radius: 50%; box-shadow: inset 0 0 32px rgba(232,182,76,.08); }
	@keyframes back-in { from { opacity: 0; transform: scale(.72) rotateY(55deg); filter: blur(7px); } }

	.reveal {
		--burst: rgba(168,168,180,.18);
		position: relative;
		display: grid;
		justify-items: center;
		gap: 16px;
		animation: reveal-in 500ms cubic-bezier(.16,1,.3,1) both;
	}
	.reveal.rarity-R { --burst: rgba(111,177,224,.28); }
	.reveal.rarity-SR { --burst: rgba(177,127,224,.36); }
	.reveal.rarity-SSR { --burst: rgba(232,182,76,.48); animation-duration: 680ms; }
	.reveal.rarity-UR { --burst: rgba(255,122,69,.58); animation-duration: 820ms; }
	@keyframes reveal-in { from { opacity: 0; transform: scale(.68) rotateY(88deg); filter: blur(7px) brightness(1.8); } }

	.reveal-card { position: relative; z-index: 2; width: min(67vw, 292px); }
	.burst,
	.rays { position: absolute; left: 50%; top: 38%; width: 75vmin; height: 75vmin; pointer-events: none; transform: translate(-50%,-50%); }
	.burst {
		border-radius: 50%;
		background: radial-gradient(circle, var(--burst), transparent 66%);
		animation: burst 900ms ease-out both;
	}
	.rays { opacity: 0; }
	.rarity-SSR .rays,
	.rarity-UR .rays {
		opacity: .62;
		background: repeating-conic-gradient(from 0deg, rgba(255,255,255,.28) 0 2deg, transparent 2deg 13deg);
		-webkit-mask: radial-gradient(circle, transparent 0 23%, black 48%, transparent 74%);
		mask: radial-gradient(circle, transparent 0 23%, black 48%, transparent 74%);
		animation: rays 1.8s ease-out both;
	}
	.rarity-UR .rays { background: repeating-conic-gradient(from 0deg, #ff9ab0 0 2deg, transparent 2deg 9deg, #9ce4ff 9deg 11deg, transparent 11deg 17deg); opacity: .76; }
	@keyframes burst { from { opacity: 1; transform: translate(-50%,-50%) scale(.25); } to { opacity: .2; transform: translate(-50%,-50%) scale(1.4); } }
	@keyframes rays { from { opacity: .9; transform: translate(-50%,-50%) scale(.3) rotate(-16deg); } to { opacity: .2; transform: translate(-50%,-50%) scale(1.25) rotate(13deg); } }

	.reveal-info { z-index: 2; display: flex; align-items: center; justify-content: center; gap: 9px; flex-wrap: wrap; }
	.reveal-info p { flex-basis: 100%; margin: -2px 0 0; color: var(--text-dim); font-size: .8rem; text-align: center; }
	.new-badge,
	.duplicate { padding: 4px 10px; border-radius: 999px; font-size: .72rem; font-weight: 900; }
	.new-badge { background: var(--accent); color: #211803; letter-spacing: .08em; }
	.duplicate { border: 1px solid var(--line); color: var(--text); }
	.row { z-index: 2; display: flex; gap: 9px; }

	@media (max-width: 350px) {
		.pack, .card-back { width: 64vw; }
		.reveal-card { width: 69vw; }
		.row .btn { padding-inline: 15px; font-size: .9rem; }
	}
	@media (prefers-reduced-motion: reduce) {
		.pack-glare,
		.pack.compress,
		.pack.tearing .tear-line,
		.pack.tearing .top-seal,
		.screen-flash,
		.card-back,
		.reveal,
		.burst,
		.rays { animation: none !important; }
	}
</style>
