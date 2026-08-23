<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';

	let { children } = $props();
</script>

<div class="app">
	{#if page.data.user}
		<header class="topbar">
			<a class="brand" href="/">LIMKETMON</a>
			<nav>
				<a href="/pull" class:active={page.url.pathname === '/pull'}>뽑기</a>
				<a href="/collection" class:active={page.url.pathname === '/collection'}>도감</a>
				<a href="/coupon" class:active={page.url.pathname === '/coupon'}>쿠폰</a>
			</nav>
		</header>
	{/if}
	<main>
		{@render children()}
	</main>
</div>

<style>
	.topbar {
		position: sticky;
		top: 0;
		z-index: 40;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 20px;
		background: rgba(16, 16, 20, 0.72);
		backdrop-filter: blur(16px) saturate(160%);
		border-bottom: 1px solid var(--line);
		padding-top: max(10px, env(safe-area-inset-top));
	}
	.brand {
		font-weight: 900;
		letter-spacing: 0.06em;
		font-size: 0.95rem;
		color: var(--accent);
		text-decoration: none;
	}
	nav {
		display: flex;
		gap: 4px;
	}
	nav a {
		padding: 8px 12px;
		border-radius: 10px;
		color: var(--text-dim);
		text-decoration: none;
		font-size: 0.92rem;
		font-weight: 600;
		transition: color 120ms, background 120ms;
	}
	nav a:active { transform: scale(0.96); }
	nav a.active {
		color: var(--text);
		background: rgba(255, 255, 255, 0.07);
	}
</style>
