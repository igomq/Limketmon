<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>LIMKETMON</title></svelte:head>

<div class="page">
	<header class="hero">
		<h1>LIMKETMON</h1>
		<p class="sub">임신규 카드 도감</p>
	</header>

	<section class="panel status">
		<div class="who">
			<span class="email">{data.user?.email}</span>
			<form method="POST" action="?/logout">
				<button class="link" type="submit">로그아웃</button>
			</form>
		</div>
		<dl class="stats">
			<div>
				<dt>오늘 무료 뽑기</dt>
				<dd class:ok={data.freeAvailable}>{data.freeAvailable ? '가능' : '완료'}</dd>
			</div>
			<div>
				<dt>뽑기권</dt>
				<dd>{data.credits}</dd>
			</div>
			<div>
				<dt>수집</dt>
				<dd>{data.completion}%<span class="dim"> {data.ownedCount}/{data.totalCount}</span></dd>
			</div>
		</dl>
		<div class="bar" role="progressbar" aria-label="도감 완성도" aria-valuenow={data.completion} aria-valuemin={0} aria-valuemax={100}>
			<div class="fill" style={`--progress: ${data.completion / 100}`}></div>
		</div>
	</section>

	<nav class="actions">
		<a class="btn btn-primary big" href="/pull">카드팩 열기</a>
		<div class="row">
			<a class="btn big" href="/collection">도감</a>
			<a class="btn big" href="/coupon">쿠폰</a>
		</div>
	</nav>
</div>

<style>
	.hero {
		text-align: center;
		margin: 28px 0 24px;
	}
	.hero h1 {
		font-size: clamp(1.6rem, 7vw, 2.2rem);
		font-weight: 800;
		letter-spacing: 0.18em;
		color: var(--accent);
	}
	.sub {
		color: var(--text-dim);
		font-size: 0.85rem;
		margin: 8px 0 0;
		letter-spacing: 0.02em;
	}

	.status { padding: 18px 20px; display: grid; gap: 16px; }
	.who {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 10px;
	}
	.email { font-weight: 600; font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; color: var(--text-dim); }
	.link {
		background: none; border: none; color: var(--text-dim);
		font-size: 0.85rem; text-decoration: underline; cursor: pointer; padding: 4px;
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 10px;
		margin: 0;
	}
	.stats > div {
		display: grid;
		gap: 4px;
		padding: 0 4px;
	}
	.stats > div + div {
		border-left: 1px solid var(--line);
		padding-left: 14px;
	}
	.stats dt {
		font-size: 0.72rem;
		color: var(--text-dim);
		letter-spacing: 0.02em;
	}
	.stats dd {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 700;
		letter-spacing: -0.01em;
	}
	.stats dd.ok { color: var(--accent); }
	.dim { margin-left: .28em; color: var(--text-dim); font-size: 0.8rem; font-weight: 600; }

	.bar {
		height: 4px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.07);
		overflow: hidden;
	}
	.fill {
		width: 100%;
		height: 100%;
		background: var(--accent);
		border-radius: inherit;
		transform: scaleX(var(--progress));
		transform-origin: left;
		transition: transform 400ms ease-out;
	}

	.actions {
		margin-top: 24px;
		display: grid;
		gap: 10px;
	}
	.big { padding: 16px 22px; font-size: 1.02rem; text-decoration: none; }
	.row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
</style>
