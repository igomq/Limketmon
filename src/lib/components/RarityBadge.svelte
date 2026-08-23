<script lang="ts">
	import { RARITY_META, type Rarity } from '$lib/cards.ts';

	let { rarity }: { rarity: Rarity } = $props();
	const meta = $derived(RARITY_META[rarity]);
</script>

<span class="badge r-{rarity}">
	<span class="tag">{rarity}</span>
	<span class="label">{meta.label}</span>
	<span class="stars" aria-hidden="true">{'★'.repeat(meta.stars)}</span>
</span>

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 4px 10px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: rgba(0, 0, 0, 0.35);
		font-size: 0.78rem;
	}
	.tag { font-weight: 900; letter-spacing: 0.1em; color: var(--r-N); }
	.badge.r-R .tag { color: var(--r-R); }
	.badge.r-SR .tag { color: var(--r-SR); }
	.badge.r-SSR .tag { color: var(--r-SSR); }
	.badge.r-UR .tag { color: var(--r-UR); }
	.label { color: var(--text-dim); letter-spacing: 0.05em; font-size: 0.68rem; }
	.stars { color: rgba(255, 255, 255, 0.5); }
</style>
