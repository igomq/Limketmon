<script lang="ts">
	import { enhance } from '$app/forms';

	let { form } = $props();
	// svelte-ignore state_referenced_locally
	let email = $state(form?.email ?? '');
	let password = $state('');
	let submitting = $state(false);
</script>

<svelte:head><title>회원가입 · LIMKETMON</title></svelte:head>

<div class="page auth">
	<div class="auth-card">
		<div class="logo">LIMKETMON</div>
		<p class="sub">가입하면 매일 무료 뽑기 1회</p>

		<form
			method="POST"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					try {
						await update();
					} finally {
						submitting = false;
					}
				};
			}}
		>
			<label class="l" for="email">이메일</label>
			<input class="field" id="email" name="email" type="email" required autocomplete="email" bind:value={email} />
			<label class="l" for="password">비밀번호 · 6자 이상</label>
			<input class="field" id="password" name="password" type="password" required minlength="6" autocomplete="new-password" bind:value={password} />
			<p class="form-error" role="alert">{form?.error ?? ''}</p>
			<button class="btn btn-primary w" type="submit" disabled={submitting}>
				{submitting ? '가입 중…' : '회원가입'}
			</button>
		</form>
	</div>

	<p class="swap">이미 계정이 있으면 <a href="/login">로그인</a></p>
</div>

<style>
	.auth {
		max-width: 400px;
		padding-top: 12vh;
		display: grid;
		gap: 20px;
		justify-items: center;
	}
	.auth-card {
		width: 100%;
		padding: 32px 28px 28px;
		border-radius: 20px;
		background: rgba(255, 255, 255, 0.035);
		border: 1px solid var(--line);
		backdrop-filter: blur(20px) saturate(140%);
		-webkit-backdrop-filter: blur(20px) saturate(140%);
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
		display: grid;
		gap: 4px;
	}
	.logo {
		text-align: center;
		font-weight: 800;
		letter-spacing: 0.22em;
		font-size: 1rem;
		color: var(--accent);
	}
	.sub {
		text-align: center;
		color: var(--text-dim);
		font-size: 0.85rem;
		margin: 2px 0 20px;
	}
	form { display: grid; gap: 6px; }
	.l { font-size: 0.78rem; color: var(--text-dim); margin-top: 10px; }
	.w { width: 100%; margin-top: 12px; }
	.swap { color: var(--text-dim); font-size: 0.85rem; }
	.swap a { color: var(--text); text-decoration: none; font-weight: 600; }
	.swap a:hover { text-decoration: underline; }
	@media (max-height: 620px) {
		.auth { padding-top: 24px; }
	}
</style>
