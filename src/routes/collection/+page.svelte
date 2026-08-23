<script lang="ts">
	import CollectionGrid from '$lib/components/CollectionGrid.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>도감 · LIMKETMON</title></svelte:head>

<div class="page">
	<CollectionGrid entries={data.entries} />
</div>
