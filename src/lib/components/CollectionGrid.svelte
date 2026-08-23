<script lang="ts">
	import { onMount } from 'svelte';
	import { RARITIES, type CardDefinition, type Rarity } from '$lib/cards.ts';
	import Card from './Card.svelte';
	import CardModal from './CardModal.svelte';

	type Entry = {
		card: CardDefinition;
		quantity: number | null;
		firstObtainedAt: string | null;
	};

	let { entries }: { entries: Entry[] } = $props();
	let rarity = $state<'ALL' | Rarity>('ALL');
	let ownership = $state<'all' | 'owned' | 'unowned'>('all');
	let sort = $state<'version' | 'rarity' | 'recent'>('version');
	let selectedId = $state<string | null>(null);
	let ready = $state(false);

	onMount(() => {
		ready = true;
	});

	const owned = $derived(entries.filter((entry) => entry.quantity !== null).length);
	const completion = $derived(entries.length ? Math.round((owned / entries.length) * 100) : 0);
	const rarityProgress = $derived(
		RARITIES.map((value) => ({
			rarity: value,
			owned: entries.filter((entry) => entry.card.rarity === value && entry.quantity !== null).length,
			total: entries.filter((entry) => entry.card.rarity === value).length
		}))
	);
	const visible = $derived.by(() => {
		const rarityRank = (value: Rarity) => RARITIES.indexOf(value);
		return entries
			.filter((entry) => rarity === 'ALL' || entry.card.rarity === rarity)
			.filter((entry) => ownership === 'all' || (ownership === 'owned') === (entry.quantity !== null))
			.toSorted((a, b) => {
				if (sort === 'rarity') return rarityRank(b.card.rarity) - rarityRank(a.card.rarity) || a.card.version - b.card.version;
				if (sort === 'recent') {
					if (!a.firstObtainedAt && !b.firstObtainedAt) return a.card.version - b.card.version;
					if (!a.firstObtainedAt) return 1;
					if (!b.firstObtainedAt) return -1;
					return b.firstObtainedAt.localeCompare(a.firstObtainedAt);
				}
				return a.card.version - b.card.version;
			});
	});
	const selected = $derived(entries.find((entry) => entry.card.id === selectedId) ?? null);
</script>

<header class="collection-head">
	<div class="title-row">
		<div>
			<h1>카드 도감</h1>
			<p>{owned}장 발견 · 전체 {entries.length}장</p>
		</div>
		<strong>{completion}%</strong>
	</div>

	<div
		class="progress"
		role="progressbar"
		aria-label="도감 완성도"
		aria-valuenow={completion}
		aria-valuemin="0"
		aria-valuemax="100"
	>
		<span style={`--progress: ${completion / 100}`}></span>
	</div>

	<div class="rarity-progress" aria-label="희귀도별 수집 현황">
		{#each rarityProgress as item}
			<span class="rarity-count rarity-{item.rarity}">
				<b>{item.rarity}</b> {item.owned}/{item.total}
			</span>
		{/each}
	</div>

	<div class="controls">
		<div class="filter-row" aria-label="희귀도 필터">
			<button class:active={rarity === 'ALL'} onclick={() => (rarity = 'ALL')}>전체</button>
			{#each RARITIES as value}
				<button class="rarity-{value}" class:active={rarity === value} onclick={() => (rarity = value)}>{value}</button>
			{/each}
		</div>
		<div class="secondary">
			<div class="segmented" aria-label="보유 여부 필터">
				<button class:active={ownership === 'all'} onclick={() => (ownership = 'all')}>모두</button>
				<button class:active={ownership === 'owned'} onclick={() => (ownership = 'owned')}>보유</button>
				<button class:active={ownership === 'unowned'} onclick={() => (ownership = 'unowned')}>미보유</button>
			</div>
			<label>
				<span class="sr-only">정렬</span>
				<select bind:value={sort} aria-label="카드 정렬">
					<option value="version">버전순</option>
					<option value="rarity">희귀도순</option>
					<option value="recent">최근 획득순</option>
				</select>
			</label>
		</div>
	</div>
</header>

{#if visible.length}
	<div class="grid" aria-label="카드 목록">
		{#each visible as entry (entry.card.id)}
			{#if entry.quantity !== null}
				<button class="cell" disabled={!ready} onclick={() => (selectedId = entry.card.id)} aria-label={`${entry.card.name} 상세 보기, ${entry.quantity}장 보유`}>
					<Card card={entry.card} quantity={entry.quantity} effect="grid" />
				</button>
			{:else}
				<div class="cell unknown-card" aria-label="아직 발견하지 못한 카드">
					<Card card={entry.card} interactive={false} effect="grid" />
					<div class="unknown" aria-hidden="true">
						<svg viewBox="0 0 24 24">
							<rect x="5" y="10" width="14" height="10" rx="2" />
							<path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
						</svg>
						<span>???</span>
					</div>
				</div>
			{/if}
		{/each}
	</div>
{:else}
	<div class="empty">
		<strong>조건에 맞는 카드가 없습니다</strong>
		<button class="btn" onclick={() => { rarity = 'ALL'; ownership = 'all'; }}>필터 초기화</button>
	</div>
{/if}

{#if selected}
	<CardModal card={selected.card} quantity={selected.quantity} onclose={() => (selectedId = null)} />
{/if}

<style>
	.collection-head { display: grid; gap: 12px; margin-bottom: 20px; }
	.title-row { display: flex; align-items: end; justify-content: space-between; gap: 18px; }
	h1 { font-size: clamp(1.35rem, 5vw, 1.7rem); }
	.title-row p { margin: 5px 0 0; color: var(--text-dim); font-size: .82rem; }
	.title-row > strong { color: var(--accent); font-size: 1.4rem; letter-spacing: -.02em; }

	.progress { height: 5px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.07); }
	.progress span {
		display: block;
		width: 100%;
		height: 100%;
		border-radius: inherit;
		background: var(--accent);
		transform: scaleX(var(--progress));
		transform-origin: left;
		transition: transform 420ms ease-out;
	}
	.rarity-progress { display: flex; flex-wrap: wrap; gap: 7px 13px; color: var(--text-dim); font-size: .71rem; }
	.rarity-count b { margin-right: 2px; color: var(--r-N); letter-spacing: .07em; }
	.rarity-count.rarity-R b { color: var(--r-R); }
	.rarity-count.rarity-SR b { color: var(--r-SR); }
	.rarity-count.rarity-SSR b { color: var(--r-SSR); }
	.rarity-count.rarity-UR b { color: var(--r-UR); }

	.controls { display: grid; gap: 9px; padding-top: 5px; }
	.filter-row { display: flex; gap: 5px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; }
	.filter-row::-webkit-scrollbar { display: none; }
	.filter-row button,
	.segmented button {
		min-height: 36px;
		padding: 6px 12px;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: transparent;
		color: var(--text-dim);
		font-size: .76rem;
		font-weight: 800;
		white-space: nowrap;
		cursor: pointer;
	}
	.filter-row button:active,
	.segmented button:active { transform: scale(.95); }
	.filter-row button.active,
	.segmented button.active { border-color: rgba(255,255,255,.26); background: rgba(255,255,255,.1); color: var(--text); }
	.filter-row .rarity-R.active { border-color: var(--r-R); color: var(--r-R); }
	.filter-row .rarity-SR.active { border-color: var(--r-SR); color: var(--r-SR); }
	.filter-row .rarity-SSR.active { border-color: var(--r-SSR); color: var(--r-SSR); }
	.filter-row .rarity-UR.active { border-color: var(--r-UR); color: var(--r-UR); }

	.secondary { display: flex; justify-content: space-between; gap: 10px; }
	.segmented { display: flex; gap: 4px; }
	.segmented button { min-height: 34px; padding: 5px 10px; border-radius: 9px; }
	select {
		min-height: 34px;
		padding: 5px 28px 5px 10px;
		border: 1px solid var(--line);
		border-radius: 9px;
		background: var(--bg-raised);
		color: var(--text);
		font: inherit;
		font-size: .76rem;
	}

	.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
	.cell { position: relative; min-width: 0; padding: 0; border: 0; border-radius: 13px; background: none; color: inherit; cursor: pointer; }
	.cell:focus-visible { outline-offset: 4px; }
	.unknown-card { cursor: default; }
	.unknown {
		position: absolute;
		inset: 0;
		display: grid;
		place-content: center;
		justify-items: center;
		gap: 7px;
		color: rgba(255,255,255,.54);
		font-size: .78rem;
		font-weight: 900;
		letter-spacing: .18em;
		text-indent: .18em;
		text-shadow: 0 2px 10px black;
		pointer-events: none;
	}
	.unknown svg { width: 22px; fill: none; stroke: currentColor; stroke-width: 1.7; }
	.empty { min-height: 34vh; display: grid; place-content: center; justify-items: center; gap: 14px; color: var(--text-dim); text-align: center; }

	@media (min-width: 560px) {
		.grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
	}
	@media (min-width: 900px) {
		.grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
	}
	@media (max-width: 350px) {
		.grid { gap: 8px; }
		.secondary { align-items: stretch; }
		.segmented { gap: 3px; }
		.segmented button { padding-inline: 8px; }
		select { max-width: 102px; }
	}
</style>
