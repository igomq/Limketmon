<script lang="ts">
	import { onMount } from 'svelte';
	import { toPng } from 'html-to-image';
	import Card from './Card.svelte';
	import RarityBadge from './RarityBadge.svelte';
	import type { CardDefinition } from '$lib/cards.ts';

	let {
		card,
		quantity = null,
		onclose
	}: {
		card: CardDefinition;
		quantity?: number | null;
		onclose: () => void;
	} = $props();

	let shareNode = $state<HTMLDivElement | null>(null);
	let shareState = $state<'idle' | 'working' | 'done' | 'error'>('idle');
	let closeBtn = $state<HTMLButtonElement | null>(null);

	onMount(() => {
		closeBtn?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onclose();
		};
		window.addEventListener('keydown', onKey);
		document.body.style.overflow = 'hidden';
		return () => {
			window.removeEventListener('keydown', onKey);
			document.body.style.overflow = '';
		};
	});

	async function makePng(): Promise<Blob | null> {
		if (!shareNode) return null;
		const dataUrl = await toPng(shareNode, {
			pixelRatio: 2,
			backgroundColor: '#101014',
			// freeze the animated foil at a flattering angle for capture
			style: { transform: 'rotateX(4deg) rotateY(-10deg)' }
		});
		const res = await fetch(dataUrl);
		return await res.blob();
	}

	async function share() {
		shareState = 'working';
		try {
			const blob = await makePng();
			if (!blob) throw new Error('capture failed');
			const file = new File([blob], `limketmon-${card.id}.png`, { type: 'image/png' });
			if (navigator.canShare?.({ files: [file] })) {
				await navigator.share({
					files: [file],
					title: 'LIMKETMON',
					text: `${card.name} (${card.rarity}) — LIMKETMON 컬렉션`
				});
				shareState = 'done';
			} else {
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = file.name;
				a.click();
				URL.revokeObjectURL(url);
				shareState = 'done';
			}
		} catch (e) {
			if ((e as Error).name !== 'AbortError') shareState = 'error';
			else shareState = 'idle';
		}
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="overlay" tabindex="-1" onclick={(e) => e.target === e.currentTarget && onclose()} role="dialog" aria-modal="true" aria-label="{card.name} 카드 상세">
	<div class="content">
		<div class="stage" bind:this={shareNode}>
			<div class="brandmark">LIMKETMON</div>
			<div class="card-wrap">
				<Card {card} {quantity} />
			</div>
			<div class="caption">
				<RarityBadge rarity={card.rarity} />
				<p class="flavor">{card.flavorText}</p>
			</div>
		</div>

		<div class="actions">
			<button class="btn btn-primary" onclick={share} disabled={shareState === 'working'}>
				{shareState === 'working' ? '이미지 생성 중…' : shareState === 'done' ? '저장 완료' : '공유 / 저장'}
			</button>
			<button class="btn" bind:this={closeBtn} onclick={() => onclose()}>닫기</button>
			{#if shareState === 'error'}
				<p class="form-error" role="alert">이미지 생성에 실패했습니다. 다시 시도해 주세요.</p>
			{/if}
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
		padding: 20px;
		background: rgba(8, 8, 11, 0.55);
		backdrop-filter: blur(18px) saturate(120%);
		-webkit-backdrop-filter: blur(18px) saturate(120%);
		animation: overlay-in 220ms ease-out;
		overflow-y: auto;
	}
	@keyframes overlay-in {
		from { opacity: 0; }
	}

	.stage {
		display: grid;
		justify-items: center;
		gap: 16px;
		padding: 28px 24px;
		border-radius: 20px;
		background: radial-gradient(120% 80% at 50% 0%, rgba(232, 182, 76, 0.09), transparent 60%), rgba(16, 16, 20, 0.9);
		border: 1px solid var(--line);
		box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6);
		animation: stage-in 320ms cubic-bezier(0.2, 0.9, 0.3, 1.15);
		max-width: min(92vw, 420px);
	}
	@keyframes stage-in {
		from { opacity: 0; transform: scale(0.86) translateY(16px); }
	}

	.brandmark {
		font-weight: 900;
		letter-spacing: 0.28em;
		font-size: 0.8rem;
		color: var(--accent);
		opacity: 0.85;
	}
	.card-wrap {
		width: min(64vw, 300px);
	}
	.caption {
		display: grid;
		gap: 10px;
		justify-items: center;
		text-align: center;
	}
	.flavor {
		margin: 0;
		color: var(--text-dim);
		font-size: 0.88rem;
		line-height: 1.5;
	}

	.actions {
		margin-top: 18px;
		display: flex;
		gap: 10px;
		justify-content: center;
		flex-wrap: wrap;
	}

	@media (prefers-reduced-motion: reduce) {
		.overlay, .stage { animation: none; }
	}
</style>
