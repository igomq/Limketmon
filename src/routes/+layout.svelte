<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';

	let { children } = $props();
</script>

<div class="app">
	<a class="skip-link" href="#main-content">본문으로 건너뛰기</a>
	{#if page.data.user}
		<header class="topbar">
			<a class="brand" href="/">LIMKETMON</a>
			<nav aria-label="주요 메뉴">
				<a href="/" class:active={page.url.pathname === '/'}>홈</a>
				<a href="/pull" class:active={page.url.pathname === '/pull'}>뽑기</a>
				<a href="/collection" class:active={page.url.pathname === '/collection'}>도감</a>
				<a href="/coupon" class:active={page.url.pathname === '/coupon'}>쿠폰</a>
			</nav>
		</header>
	{/if}
	<main id="main-content">
		{@render children()}
	</main>
</div>

<style>
	.skip-link {
		position: fixed;
		left: 12px;
		top: 12px;
		z-index: 200;
		padding: 9px 13px;
		border-radius: 9px;
		background: var(--accent);
		color: #1f1602;
		font-weight: 800;
		text-decoration: none;
		transform: translateY(-150%);
	}
	.skip-link:focus { transform: translateY(0); }

	.topbar {
		position: sticky;
		top: 0;
		z-index: 40;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 20px;
		background: rgba(16, 16, 20, 0.78);
		backdrop-filter: blur(18px) saturate(155%);
		-webkit-backdrop-filter: blur(18px) saturate(155%);
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

	@media (max-width: 759px) {
		.topbar {
			min-height: 49px;
			justify-content: center;
			padding-inline: 16px;
			background: var(--bg);
			backdrop-filter: none;
			-webkit-backdrop-filter: none;
		}
		.brand { font-size: .88rem; letter-spacing: .15em; text-indent: .15em; }
		nav {
			position: fixed;
			left: max(10px, env(safe-area-inset-left));
			right: max(10px, env(safe-area-inset-right));
			bottom: max(8px, env(safe-area-inset-bottom));
			z-index: 80;
			display: grid;
			grid-template-columns: repeat(4, 1fr);
			padding: 5px;
			border: 1px solid rgba(255,255,255,.1);
			border-radius: 15px;
			background: rgba(22,22,28,.9);
			box-shadow: 0 14px 40px rgba(0,0,0,.52);
			backdrop-filter: blur(20px) saturate(160%);
			-webkit-backdrop-filter: blur(20px) saturate(160%);
		}
		nav a { min-height: 42px; display: grid; place-items: center; padding: 7px 5px; font-size: .78rem; }
	}

	@media (prefers-reduced-transparency: reduce) {
		.topbar,
		nav { background: #15151a; backdrop-filter: none; }
	}
</style>
