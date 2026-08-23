<script lang="ts">
	import { RARITY_META, type CardDefinition } from '$lib/cards.ts';

	let {
		card,
		quantity = null,
		interactive = true
	}: {
		card: CardDefinition;
		quantity?: number | null;
		interactive?: boolean;
	} = $props();

	let frame = $state<HTMLDivElement | null>(null);
	// pointer-driven tilt. Custom props so foil/glare track the same pointer.
	function onMove(e: PointerEvent) {
		if (!interactive || !frame) return;
		const r = frame.getBoundingClientRect();
		const px = (e.clientX - r.left) / r.width;
		const py = (e.clientY - r.top) / r.height;
		frame.style.setProperty('--px', String(px));
		frame.style.setProperty('--py', String(py));
		frame.style.setProperty('--ry', String((px - 0.5) * 16));
		frame.style.setProperty('--rx', String((0.5 - py) * 12));
	}
	function onLeave() {
		if (!frame) return;
		frame.style.setProperty('--rx', '0');
		frame.style.setProperty('--ry', '0');
	}

	const meta = $derived(RARITY_META[card.rarity]);
</script>

<div
	class="card r-{card.rarity}"
	class:locked={!interactive}
	bind:this={frame}
	onpointermove={onMove}
	onpointerleave={onLeave}
	role="img"
	aria-label="{card.name}, {card.rarity} 카드"
>
	<div class="inner">
		<div class="top">
			<span class="rarity">{card.rarity}</span>
			<span class="stars" aria-hidden="true">{'★'.repeat(meta.stars)}</span>
		</div>

		<div class="art">
			<img src="/cards/{card.imageKey}" alt="" draggable="false" loading="lazy" />
			<div class="art-vignette"></div>
			<div class="foil"></div>
			<div class="glare"></div>
			<div class="sparkles"></div>
		</div>

		<div class="body">
			<div class="name">{card.name}</div>
			<div class="skill">
				<span class="skill-name">[{card.skillName}]</span>
				<span class="skill-desc">{card.skillDescription}</span>
			</div>
			<div class="stats">
				<span>ATK <b>{card.attack}</b></span>
				<span>DEF <b>{card.defense}</b></span>
				<span>LUCK <b>{card.luck}</b></span>
			</div>
		</div>

		{#if quantity !== null && quantity > 1}
			<span class="qty" aria-label="보유 수량">×{quantity}</span>
		{/if}
	</div>
</div>

<style>
	.card {
		--px: 0.5;
		--py: 0.5;
		--rx: 0deg;
		--ry: 0deg;
		aspect-ratio: 5 / 7;
		perspective: 900px;
		touch-action: pan-y;
	}
	.inner {
		position: relative;
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		border-radius: 12px;
		overflow: hidden;
		background: linear-gradient(180deg, #1d1d24, #14141a);
		border: 1px solid var(--r-N);
		transform: rotateX(var(--rx)) rotateY(var(--ry));
		transform-style: preserve-3d;
		will-change: transform;
		transition: transform 350ms cubic-bezier(0.2, 0.9, 0.3, 1);
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
		container-type: inline-size;
	}

	/* rarity framing */
	.card.r-R .inner { border-color: var(--r-R); box-shadow: 0 10px 30px rgba(0,0,0,.5), 0 0 14px rgba(111,177,224,.18); }
	.card.r-SR .inner { border-color: var(--r-SR); box-shadow: 0 10px 30px rgba(0,0,0,.5), 0 0 18px rgba(177,127,224,.28); }
	.card.r-SSR .inner { border-color: var(--r-SSR); box-shadow: 0 10px 30px rgba(0,0,0,.5), 0 0 24px rgba(232,182,76,.35); }
	.card.r-UR .inner { border-color: var(--r-UR); box-shadow: 0 10px 30px rgba(0,0,0,.5), 0 0 34px rgba(255,122,69,.45); }

	.card.r-SSR .inner::before,
	.card.r-UR .inner::before {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		padding: 1.5px;
		background: linear-gradient(135deg, var(--gold-hi), transparent 30%, transparent 70%, var(--accent));
		-webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
		mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
		-webkit-mask-composite: xor;
		mask-composite: exclude;
		z-index: 3;
		pointer-events: none;
	}

	.top {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		padding: 7px 10px 5px;
		font-size: clamp(0.6rem, 8cqw, 0.85rem);
	}
	.rarity {
		font-weight: 900;
		letter-spacing: 0.12em;
		color: var(--r-N);
	}
	.card.r-R .rarity { color: var(--r-R); }
	.card.r-SR .rarity { color: var(--r-SR); }
	.card.r-SSR .rarity { color: var(--r-SSR); }
	.card.r-UR .rarity { color: var(--r-UR); }
	.stars { color: rgba(255, 255, 255, 0.55); letter-spacing: 0.1em; }

	.art {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		background: #0b0b0f;
	}
	.art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
		user-select: none;
	}

	.art-vignette {
		position: absolute;
		inset: 0;
		background:
			linear-gradient(180deg, rgba(0,0,0,.25), transparent 22%, transparent 72%, rgba(0,0,0,.55)),
			radial-gradient(120% 90% at 50% 40%, transparent 60%, rgba(0, 0, 0, 0.35));
		pointer-events: none;
	}

	/* glare: a soft specular spot that tracks the pointer */
	.glare {
		position: absolute;
		inset: 0;
		background: radial-gradient(
			48% 36% at calc(var(--px) * 100%) calc(var(--py) * 100%),
			rgba(255, 255, 255, 0.34),
			rgba(255, 255, 255, 0.08) 45%,
			transparent 70%
		);
		mix-blend-mode: screen;
		pointer-events: none;
	}

	/* foil: rarity-dependent. N gets a faint gloss, UR gets a moving spectrum. */
	.foil {
		position: absolute;
		inset: 0;
		pointer-events: none;
		opacity: 0.12;
		background: repeating-linear-gradient(
			115deg,
			rgba(255, 255, 255, 0.35) 0 2px,
			transparent 2px 9px
		);
	}
	.card.r-R .foil { opacity: 0.18; }
	.card.r-SR .foil {
		opacity: 0.3;
		mix-blend-mode: overlay;
		background: conic-gradient(
			from calc(var(--px) * 360deg),
			#7ec8ff, #d9a7ff, #ffd98a, #7ec8ff
		);
		background-size: 200% 200%;
		animation: foil-drift 5s linear infinite;
	}
	.card.r-SSR .foil,
	.card.r-UR .foil {
		opacity: 0.42;
		mix-blend-mode: color-dodge;
		background: conic-gradient(
			from calc(var(--px) * 540deg),
			#ff9a9a, #ffd98a, #9affc8, #9ad4ff, #d9a7ff, #ff9a9a
		);
		background-size: 220% 220%;
		animation: foil-drift 4s linear infinite;
	}
	.card.r-UR .foil { opacity: 0.55; animation-duration: 2.6s; }

	@keyframes foil-drift {
		0% { background-position: 0% 0%; }
		100% { background-position: 200% 200%; }
	}

	/* UR-only sparkle glints */
	.sparkles {
		position: absolute;
		inset: 0;
		pointer-events: none;
		opacity: 0;
	}
	.card.r-UR .sparkles {
		opacity: 1;
		background:
			radial-gradient(4px 4px at 22% 30%, rgba(255,255,255,.95), transparent 60%),
			radial-gradient(3px 3px at 72% 22%, rgba(255,240,200,.9), transparent 60%),
			radial-gradient(5px 5px at 60% 74%, rgba(255,255,255,.8), transparent 60%),
			radial-gradient(3px 3px at 34% 82%, rgba(255,220,170,.85), transparent 60%),
			radial-gradient(3px 3px at 85% 58%, rgba(255,255,255,.9), transparent 60%);
		animation: twinkle 2.2s ease-in-out infinite;
	}
	@keyframes twinkle {
		0%, 100% { transform: scale(1); opacity: 0.9; }
		50% { transform: scale(1.25); opacity: 0.35; }
	}

	.body {
		padding: 7px 10px 9px;
		background: linear-gradient(180deg, rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.15));
		display: grid;
		gap: 3px;
	}
	.name {
		font-weight: 800;
		font-size: clamp(0.68rem, 9cqw, 0.95rem);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.skill {
		display: flex;
		flex-direction: column;
		gap: 1px;
		font-size: clamp(0.55rem, 6.5cqw, 0.72rem);
		color: var(--text-dim);
		line-height: 1.35;
	}
	.skill-name { color: var(--accent); font-weight: 700; }
	.stats {
		display: flex;
		gap: 12px;
		font-size: clamp(0.55rem, 6.5cqw, 0.72rem);
		color: var(--text-dim);
		letter-spacing: 0.04em;
	}
	.stats b { color: var(--text); }

	.qty {
		position: absolute;
		top: 30px;
		right: 6px;
		z-index: 4;
		background: rgba(0, 0, 0, 0.65);
		border: 1px solid var(--line);
		color: var(--accent);
		font-weight: 800;
		font-size: 0.7rem;
		padding: 2px 7px;
		border-radius: 999px;
	}

	/* locked (unowned) collection placeholder: silhouette + hidden identity */
	.locked .art img {
		filter: brightness(0.25) grayscale(1) blur(1.5px);
	}
	.locked .name,
	.locked .skill,
	.locked .rarity {
		filter: blur(4px);
		user-select: none;
	}
</style>
