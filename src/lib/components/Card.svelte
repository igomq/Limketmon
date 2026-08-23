<script lang="ts">
	import { resolveCardImage, RARITY_META, type CardDefinition } from '$lib/cards.ts';

	let {
		card,
		quantity = null,
		interactive = true,
		effect: effectMode = 'full'
	}: {
		card: CardDefinition;
		quantity?: number | null;
		interactive?: boolean;
		effect?: 'full' | 'grid' | 'static';
	} = $props();

	let frame = $state<HTMLDivElement | null>(null);
	let active = $state(false);
	let pointerId: number | null = null;
	let startX = 0;
	let startY = 0;
	let touchIntent: 'pending' | 'tilt' | 'scroll' = 'pending';
	let raf = 0;
	let nextX = 0.5;
	let nextY = 0.5;

	const meta = $derived(RARITY_META[card.rarity]);
	const canTilt = $derived(interactive && effectMode === 'full');

	function paint() {
		raf = 0;
		if (!frame) return;
		const fromCenter = Math.min(1, Math.hypot(nextX - 0.5, nextY - 0.5) * 1.42);
		frame.style.setProperty('--pointer-x', `${nextX * 100}%`);
		frame.style.setProperty('--pointer-y', `${nextY * 100}%`);
		frame.style.setProperty('--pointer-from-center', String(fromCenter));
		frame.style.setProperty('--rotate-x', `${(0.5 - nextY) * 13}deg`);
		frame.style.setProperty('--rotate-y', `${(nextX - 0.5) * 17}deg`);
		frame.style.setProperty('--background-x', `${18 + nextX * 64}%`);
		frame.style.setProperty('--background-y', `${18 + nextY * 64}%`);
		frame.style.setProperty('--art-x', `${(0.5 - nextX) * 5}px`);
		frame.style.setProperty('--art-y', `${(0.5 - nextY) * 5}px`);
	}

	function update(clientX: number, clientY: number) {
		if (!frame) return;
		const rect = frame.getBoundingClientRect();
		nextX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
		nextY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
		if (!raf) raf = requestAnimationFrame(paint);
	}

	function reset() {
		active = false;
		pointerId = null;
		touchIntent = 'pending';
		nextX = 0.5;
		nextY = 0.5;
		if (!raf) raf = requestAnimationFrame(paint);
	}

	function onPointerDown(event: PointerEvent) {
		if (!canTilt || event.button !== 0) return;
		pointerId = event.pointerId;
		startX = event.clientX;
		startY = event.clientY;
		touchIntent = event.pointerType === 'touch' ? 'pending' : 'tilt';
		active = event.pointerType !== 'touch';
		if (active) frame?.setPointerCapture(event.pointerId);
		update(event.clientX, event.clientY);
	}

	function onPointerMove(event: PointerEvent) {
		if (!canTilt) return;
		if (event.pointerType === 'mouse' && pointerId === null) {
			active = true;
			update(event.clientX, event.clientY);
			return;
		}
		if (pointerId !== event.pointerId || touchIntent === 'scroll') return;

		if (touchIntent === 'pending') {
			const dx = event.clientX - startX;
			const dy = event.clientY - startY;
			if (Math.hypot(dx, dy) < 10) return;
			if (Math.abs(dy) > Math.abs(dx)) {
				touchIntent = 'scroll';
				reset();
				return;
			}
			touchIntent = 'tilt';
			active = true;
			frame?.setPointerCapture(event.pointerId);
		}
		update(event.clientX, event.clientY);
	}

	function onPointerEnd(event: PointerEvent) {
		if (pointerId === event.pointerId || event.pointerType === 'mouse') reset();
	}

	function onPointerLeave(event: PointerEvent) {
		if (event.pointerType === 'mouse' && pointerId === null) reset();
	}

	$effect(() => () => cancelAnimationFrame(raf));
</script>

<div
	class="card rarity-{card.rarity} effect-{effectMode}"
	class:concealed={!interactive}
	class:active
	bind:this={frame}
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerEnd}
	onpointercancel={onPointerEnd}
	onpointerleave={onPointerLeave}
	role="img"
	aria-label={interactive ? `${card.name}, ${card.rarity} 카드` : '아직 발견하지 못한 카드'}
>
	<div class="card-shell">
		<div class="surface" aria-hidden="true"></div>
		<header class="topline">
			<span class="rarity">{card.rarity}</span>
			<span class="stars" aria-hidden="true">{'★'.repeat(meta.stars)}</span>
		</header>

		<div class="art">
			<img src={resolveCardImage(card.imageKey)} alt="" draggable="false" loading="lazy" />
			<div class="art-depth" aria-hidden="true"></div>
			<div class="foil foil-spectrum" aria-hidden="true"></div>
			<div class="foil foil-prism" aria-hidden="true"></div>
			<div class="glare" aria-hidden="true"></div>
			<div class="glints" aria-hidden="true"></div>
		</div>

		<div class="body">
			<div class="name">{card.name}</div>
			<div class="skill">
				<span class="skill-name">[{card.skillName}]</span>
				<span class="skill-desc">{card.skillDescription}</span>
			</div>
			<div class="stats" aria-label={`공격 ${card.attack}, 방어 ${card.defense}, 행운 ${card.luck}`}>
				<span>ATK <b>{card.attack}</b></span>
				<span>DEF <b>{card.defense}</b></span>
				<span>LUCK <b>{card.luck}</b></span>
			</div>
		</div>

		{#if quantity !== null && quantity > 1}
			<span class="quantity" aria-label={`보유 수량 ${quantity}장`}>×{quantity}</span>
		{/if}
	</div>
</div>

<style>
	.card {
		--pointer-x: 50%;
		--pointer-y: 50%;
		--pointer-from-center: 0;
		--rotate-x: 0deg;
		--rotate-y: 0deg;
		--background-x: 50%;
		--background-y: 50%;
		--art-x: 0px;
		--art-y: 0px;
		--rarity-color: var(--r-N);
		--rarity-glow: rgba(168, 168, 180, 0.12);
		aspect-ratio: 5 / 7;
		perspective: 980px;
		touch-action: pan-y;
		-webkit-tap-highlight-color: transparent;
	}

	.card.rarity-R { --rarity-color: var(--r-R); --rarity-glow: rgba(111, 177, 224, 0.2); }
	.card.rarity-SR { --rarity-color: var(--r-SR); --rarity-glow: rgba(177, 127, 224, 0.27); }
	.card.rarity-SSR { --rarity-color: var(--r-SSR); --rarity-glow: rgba(232, 182, 76, 0.34); }
	.card.rarity-UR { --rarity-color: var(--r-UR); --rarity-glow: rgba(255, 122, 69, 0.42); }

	.card-shell {
		position: relative;
		isolation: isolate;
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid var(--rarity-color);
		border-radius: 13px;
		background: linear-gradient(160deg, #24242c, #111116 72%);
		box-shadow: 0 16px 34px rgba(0, 0, 0, 0.48), 0 8px 18px var(--rarity-glow);
		container-type: inline-size;
		transform: rotateX(var(--rotate-x)) rotateY(var(--rotate-y)) scale(1);
		transform-style: preserve-3d;
		transition: transform 430ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 300ms ease-out;
	}

	.effect-full.active .card-shell {
		transform: rotateX(var(--rotate-x)) rotateY(var(--rotate-y)) scale(1.025);
		transition-duration: 60ms;
		transition-timing-function: linear;
		box-shadow: 0 22px 48px rgba(0, 0, 0, 0.58), 0 10px 28px var(--rarity-glow);
		will-change: transform;
	}

	.surface {
		position: absolute;
		inset: 0;
		z-index: 7;
		border-radius: inherit;
		pointer-events: none;
		background:
			linear-gradient(115deg, transparent 22%, rgba(255, 255, 255, 0.13) 43%, transparent 59%),
			radial-gradient(80% 62% at var(--pointer-x) var(--pointer-y), rgba(255, 255, 255, 0.12), transparent 64%);
		background-position: var(--background-x) var(--background-y);
		mix-blend-mode: screen;
		opacity: 0.34;
	}

	.rarity-R .card-shell {
		border-color: #b8d8ec;
		background: linear-gradient(125deg, #3d4650, #11171d 34%, #26333d 62%, #101419);
	}

	.rarity-SR .card-shell { border-width: 1.5px; }
	.rarity-SSR .card-shell,
	.rarity-UR .card-shell { border-color: transparent; }

	.rarity-SSR .card-shell::before,
	.rarity-UR .card-shell::before {
		content: '';
		position: absolute;
		inset: 0;
		z-index: 9;
		padding: 2px;
		border-radius: inherit;
		background: conic-gradient(from 210deg, #fff3b0, #ff9db6, #a9e7ff, #bca8ff, #8fffc2, #fff3b0);
		-webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
		mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
		-webkit-mask-composite: xor;
		mask-composite: exclude;
		pointer-events: none;
	}

	.rarity-UR .card-shell::before {
		padding: 3px;
		background: conic-gradient(from 180deg at var(--pointer-x) var(--pointer-y), #fff7c2, #ff8f72, #eec5ff, #82dfff, #8effb7, #fff7c2);
		filter: saturate(1.2) brightness(1.12);
	}

	.topline {
		position: relative;
		z-index: 5;
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		padding: 7px 10px 6px;
		font-size: clamp(0.58rem, 8cqw, 0.84rem);
		background: rgba(10, 10, 14, 0.55);
		transform: translateZ(8px);
	}

	.rarity { color: var(--rarity-color); font-weight: 950; letter-spacing: 0.13em; }
	.rarity-UR .rarity {
		color: #ffd7a0;
		text-shadow: 0 1px 0 #6e2a14, 0 0 10px rgba(255, 196, 128, 0.35);
	}
	.stars { color: rgba(255, 255, 255, 0.62); letter-spacing: 0.08em; }

	.art {
		position: relative;
		isolation: isolate;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		background: #08080b;
		transform: translateZ(5px);
	}

	.art img {
		width: 104%;
		height: 104%;
		margin: -2%;
		display: block;
		object-fit: cover;
		user-select: none;
		transform: translate3d(var(--art-x), var(--art-y), 0) scale(1.015);
		transition: transform 430ms cubic-bezier(0.16, 1, 0.3, 1);
	}

	.active .art img { transition-duration: 60ms; transition-timing-function: linear; }

	.art-depth {
		position: absolute;
		inset: 0;
		z-index: 1;
		background:
			linear-gradient(180deg, rgba(0, 0, 0, 0.22), transparent 20%, transparent 68%, rgba(0, 0, 0, 0.62)),
			radial-gradient(110% 85% at 50% 42%, transparent 52%, rgba(0, 0, 0, 0.44));
		pointer-events: none;
	}

	.foil,
	.glare,
	.glints { position: absolute; inset: 0; pointer-events: none; }

	.foil-spectrum {
		z-index: 2;
		opacity: 0.08;
		background: linear-gradient(112deg, transparent 20%, rgba(255,255,255,.5) 45%, transparent 68%);
		background-position: var(--background-x) var(--background-y);
		background-size: 180% 180%;
		mix-blend-mode: screen;
	}

	.rarity-R .foil-spectrum {
		opacity: 0.28;
		background: linear-gradient(112deg, transparent 24%, rgba(205, 236, 255, 0.72) 44%, transparent 59%);
	}

	.rarity-SR .foil-spectrum {
		opacity: 0.45;
		background: linear-gradient(118deg, transparent 20%, rgba(151, 215, 255, 0.62), rgba(224, 159, 255, 0.65), transparent 70%);
		background-size: 210% 210%;
		mix-blend-mode: color-dodge;
	}

	.rarity-SSR .foil-spectrum,
	.rarity-UR .foil-spectrum {
		opacity: 0.53;
		background:
			linear-gradient(118deg, transparent 14%, rgba(255,255,255,.55) 32%, transparent 49%),
			conic-gradient(from 220deg at var(--pointer-x) var(--pointer-y), #ff718d, #ffd36e, #74ffc3, #72cfff, #bf88ff, #ff718d);
		background-size: 230% 230%, 170% 170%;
		background-position: var(--background-x) var(--background-y);
		mix-blend-mode: color-dodge;
		filter: saturate(1.18);
	}

	.rarity-UR .foil-spectrum { opacity: 0.65; filter: saturate(1.4) contrast(1.08); }

	.foil-prism { z-index: 3; opacity: 0; }
	.rarity-SSR .foil-prism,
	.rarity-UR .foil-prism {
		opacity: 0.24;
		background:
			repeating-conic-gradient(from 15deg at var(--pointer-x) var(--pointer-y), rgba(255,255,255,.65) 0 2deg, transparent 2deg 11deg),
			radial-gradient(circle at var(--pointer-x) var(--pointer-y), rgba(255,255,255,.5), transparent 34%);
		background-size: 130% 130%;
		mix-blend-mode: soft-light;
	}
	.rarity-UR .foil-prism { opacity: 0.36; mix-blend-mode: color-dodge; }

	.glare {
		z-index: 4;
		opacity: calc(0.15 + var(--pointer-from-center) * 0.42);
		background: radial-gradient(46% 34% at var(--pointer-x) var(--pointer-y), rgba(255,255,255,.68), rgba(255,255,255,.12) 42%, transparent 72%);
		mix-blend-mode: screen;
	}

	.glints { z-index: 5; opacity: 0; }
	.rarity-SSR .glints,
	.rarity-UR .glints {
		opacity: 0.72;
		background:
			radial-gradient(5px 5px at 18% 27%, white, transparent 62%),
			radial-gradient(3px 3px at 74% 19%, #fff5cc, transparent 64%),
			radial-gradient(4px 4px at 63% 73%, white, transparent 64%),
			radial-gradient(3px 3px at 87% 54%, #dff8ff, transparent 64%);
		filter: drop-shadow(0 0 5px white);
	}
	.rarity-UR .glints { opacity: 0.95; }

	.effect-full.rarity-SR .foil-spectrum { animation: foil-sweep 4.8s ease-in-out infinite; }
	.effect-full.rarity-SSR .foil-spectrum { animation: foil-sweep 3.8s ease-in-out infinite; }
	.effect-full.rarity-UR .foil-spectrum { animation: foil-sweep 2.9s ease-in-out infinite; }
	.effect-full.rarity-SSR .glints,
	.effect-full.rarity-UR .glints { animation: glint 2.4s ease-in-out infinite alternate; }

	@keyframes foil-sweep {
		0%, 100% { background-position: 15% 20%; }
		50% { background-position: 85% 76%; }
	}
	@keyframes glint {
		0%, 38% { opacity: 0.28; }
		60%, 100% { opacity: 0.95; }
	}

	.body {
		position: relative;
		z-index: 5;
		display: grid;
		gap: 3px;
		padding: 7px 10px 9px;
		background: linear-gradient(180deg, rgba(13, 13, 18, 0.92), rgba(18, 18, 23, 0.99));
		transform: translateZ(9px);
	}

	.name {
		overflow: hidden;
		font-size: clamp(0.66rem, 9cqw, 0.94rem);
		font-weight: 850;
		letter-spacing: -0.018em;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.rarity-UR .name { text-shadow: 0 1px 0 rgba(255, 183, 122, 0.32); }
	.skill { display: flex; flex-direction: column; gap: 1px; color: var(--text-dim); font-size: clamp(0.52rem, 6.4cqw, 0.7rem); line-height: 1.35; }
	.skill-name { color: var(--rarity-color); font-weight: 750; }
	.skill-desc { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 1; line-clamp: 1; }
	.stats { display: flex; justify-content: space-between; gap: 5px; color: var(--text-dim); font-size: clamp(0.5rem, 6.2cqw, 0.69rem); letter-spacing: 0.025em; }
	.stats b { color: var(--text); }

	.quantity {
		position: absolute;
		top: 29px;
		right: 7px;
		z-index: 10;
		padding: 3px 8px;
		border: 1px solid rgba(255,255,255,.2);
		border-radius: 999px;
		background: rgba(6, 6, 9, 0.78);
		color: var(--gold-hi);
		font-size: 0.7rem;
		font-weight: 850;
		box-shadow: 0 5px 14px rgba(0,0,0,.28);
	}

	.concealed .art img { filter: brightness(0.12) grayscale(1) blur(3px); transform: scale(1.06); }
	.concealed .foil,
	.concealed .glare,
	.concealed .glints,
	.concealed .surface { display: none; }
	.concealed .name,
	.concealed .skill,
	.concealed .rarity,
	.concealed .stars,
	.concealed .stats { color: transparent; text-shadow: 0 0 7px rgba(255,255,255,.18); user-select: none; }
	.concealed .card-shell { border-color: rgba(255,255,255,.1); box-shadow: 0 12px 28px rgba(0,0,0,.4); }

	.effect-static .card-shell { transform: rotateX(3deg) rotateY(-6deg); }
	.effect-static .foil-spectrum { animation: none; background-position: 68% 34%; }
	.effect-static .glints { animation: none; opacity: 0.82; }

	@media (hover: hover) and (pointer: fine) {
		.effect-grid:not(.concealed):hover .card-shell { transform: translateY(-3px) scale(1.012); box-shadow: 0 19px 38px rgba(0,0,0,.54), 0 9px 20px var(--rarity-glow); }
	}

	@media (prefers-reduced-motion: reduce) {
		.card-shell,
		.art img { transition: opacity 160ms ease-out; transform: none !important; }
		.foil-spectrum,
		.glints { animation: none !important; }
		.glare { opacity: 0.12; }
	}
</style>
