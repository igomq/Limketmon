<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
	let code = $state('');
	let submitting = $state(false);
</script>

<svelte:head><title>쿠폰 · LIMKETMON</title></svelte:head>

<div class="page coupon">
	<header>
		<h1>쿠폰</h1>
		<p class="sub">뽑기권 받기 · 계정당 1회</p>
	</header>

	<form
		method="POST"
		use:enhance={() => {
			submitting = true;
			return async ({ update, result }) => {
				try {
					await update();
					if (result.type === 'success') code = '';
				} finally {
					submitting = false;
				}
			};
		}}
	>
		<label class="sr-only" for="code">쿠폰 코드</label>
		<input
			class="field code"
			id="code"
			name="code"
			placeholder="쿠폰 코드"
			required
			autocomplete="off"
			autocapitalize="characters"
			spellcheck="false"
			bind:value={code}
			aria-describedby="coupon-feedback"
		/>
		<button class="btn btn-primary w" type="submit" disabled={submitting}>
			{submitting ? '확인 중…' : '등록'}
		</button>
	</form>

	<div id="coupon-feedback" class="feedback" aria-live="polite">
	{#if form?.success}
		<p class="ok">쿠폰 등록 완료 · 뽑기권 +100</p>
	{:else if form?.error}
		<p class="form-error">{form.error}</p>
	{/if}
	</div>

	<section class="panel have">
		현재 보유 뽑기권 <b>{form?.credits ?? data.credits}</b>
	</section>
</div>

<style>
	.coupon { max-width: 420px; }
	header { margin-bottom: 24px; }
	h1 { font-size: 1.3rem; }
	.sub { color: var(--text-dim); font-size: 0.88rem; margin-top: 6px; }
	form { display: grid; gap: 12px; }
	.code { text-align: center; letter-spacing: 0.2em; font-weight: 800; text-transform: uppercase; }
	.w { width: 100%; }
	.ok {
		color: var(--accent);
		font-weight: 700;
		text-align: center;
	}
	.feedback { min-height: 1.5rem; margin-top: 10px; text-align: center; }
	.feedback p { margin: 0; }
	.have {
		margin-top: 24px;
		padding: 16px;
		text-align: center;
		color: var(--text-dim);
	}
	.have b { color: var(--text); font-size: 1.2rem; }
</style>
