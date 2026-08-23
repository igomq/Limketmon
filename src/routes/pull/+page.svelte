<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import PackOpening from '$lib/components/PackOpening.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>카드뽑기 · LIMKETMON</title></svelte:head>

<div class="page">
	<header class="head">
		<h1>카드뽑기</h1>
		<div class="chips">
			<span class="chip" class:ok={data.freeAvailable}>
				무료 {data.freeAvailable ? '가능' : '사용 완료'}
			</span>
			<span class="chip">뽑기권 {data.credits}</span>
		</div>
	</header>

	<PackOpening
		doPull={async () => {
			const res = await fetch('/api/pull', { method: 'POST' });
			const body = await res.json();
			if (!res.ok) throw new Error(body.message ?? '뽑기에 실패했습니다.');
			await invalidateAll();
			return body;
		}}
		onexit={() => goto('/collection')}
	/>
</div>

<style>
	.head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 10px;
		margin-bottom: 8px;
		flex-wrap: wrap;
	}
	h1 { font-size: 1.3rem; }
	.chips { display: flex; gap: 8px; }
	.chip {
		padding: 5px 12px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--bg-panel);
		font-size: 0.78rem;
		color: var(--text-dim);
		font-weight: 700;
	}
	.chip.ok {
		color: var(--accent);
		border-color: rgba(232, 182, 76, 0.45);
	}
	@media (max-width: 350px) {
		.head { align-items: flex-start; }
		.chips { gap: 5px; }
		.chip { padding-inline: 9px; font-size: .72rem; }
	}
</style>
