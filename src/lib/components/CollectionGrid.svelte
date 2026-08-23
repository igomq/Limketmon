<script lang="ts">
	import { RARITIES, type CardDefinition } from '$lib/cards.ts';
	import Card from '$lib/components/Card.svelte';
	import CardModal from '$lib/components/CardModal.svelte';

	let {
		entries
	}: {
		entries: Array<{ card: CardDefinition; quantity: number | null }>;
	} = $props();

	let filter = $state<'ALL' | (typeof RARITIES)[number]>('ALL');
	let selected = $state<number | null>(null);

	const filtered = $derived(
		filter === 'ALL' ? entries : entries.filter((e) => e.card.rarity === filter)
	);
	const owned = $derived(entries.filter((e) => e.quantity !== null).length);
	const completion = $derived(
		entries.length === 0 ? 0 : Math.round((owned / entries.length) * 100)
	);
</script>

<header class="head">
	<h1>도감</h1>
	<div class="meta">
		<span>{owned} / {entries.length}</span>
		<span class="pct">{completion}%</span>
	</div>
	<div class="bar" role="progressbar" aria-valuenow={completion} aria-valuemin={0} aria-valuemax={100}
		><div class="fill" style="width: {completion}%"></div
	></div>
	<div class="filters" role="tablist" aria-label="레어티 필터">
		<button class="f" class:on={filter === 'ALL'} onclick={() => (filter = 'ALL')}>ALL</button>
		{#each RARITIES as r}
			<button class="f r-{r}" class:on={filter === r} onclick={() => (filter = r)}>{r}</button>
		{/each}
	</div>
</header>

<div class="grid">
	{#each filtered as entry, i (entry.card.id)}
		{#if entry.quantity !== null}
			<button class="cell" onclick={() => (selected = entries.indexOf(entry))} aria-label="{entry.card.name} 상세 보기">
				<Card card={entry.card} quantity={entry.quantity} />
			</button>
		{:else}
			<div class="cell locked" aria-label="미획득 카드">
				<Card card={entry.card} interactive={false} />
				<span class="unknown">???</span>
			</div>
		{/if}
	{/each}
</div>

{#if selected !== null && entries[selected]}
	<CardModal
		card={entries[selected].card}
		quantity={entries[selected].quantity}
		onclose={() => (selected = null)}
	/>
{/if}

<style>
	.head { margin-bottom: 20px; display: grid; gap: 10px; }
	h1 { font-size: 1.3rem; }
	.meta { display: flex; justify-content: space-between; color: var(--text-dim); font-size: 0.85rem; font-weight: 700; }
	.pct { color: var(--accent); }
	.bar {
		height: 6px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.07);
		overflow: hidden;
	}
	.fill {
		height: 100%;
		background: linear-gradient(90deg, var(--accent-deep), var(--gold-hi));
		border-radius: inherit;
		transition: width 400ms ease-out;
	}
	.filters { display: flex; gap: 6px; flex-wrap: wrap; }
	.f {
		padding: 6px 14px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--text-dim);
		font-weight: 800;
		font-size: 0.78rem;
		letter-spacing: 0.06em;
		cursor: pointer;
	}
	.f:active { transform: scale(0.95); }
	.f.on { background: rgba(255, 255, 255, 0.1); color: var(--text); border-color: rgba(255,255,255,.25); }
	.f.r-R.on { color: var(--r-R); border-color: var(--r-R); }
	.f.r-SR.on { color: var(--r-SR); border-color: var(--r-SR); }
	.f.r-SSR.on { color: var(--r-SSR); border-color: var(--r-SSR); }
	.f.r-UR.on { color: var(--r-UR); border-color: var(--r-UR); }

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 14px;
	}
	@media (min-width: 720px) {
		.grid { grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
	}
	.cell {
		position: relative;
		border: none;
		background: none;
		padding: 0;
		cursor: pointer;
		border-radius: 12px;
	}
	.cell.locked { cursor: default; }
	.unknown {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		font-weight: 900;
		letter-spacing: 0.2em;
		color: rgba(255, 255, 255, 0.5);
		text-shadow: 0 2px 8px rgba(0, 0, 0, 0.8);
		pointer-events: none;
	}
</style>
