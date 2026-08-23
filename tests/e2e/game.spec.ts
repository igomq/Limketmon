import { expect, test, type Page } from '@playwright/test';

const password = 'cardpack123';

async function signup(page: Page, email: string) {
	await page.goto('/signup');
	await page.getByLabel('이메일').fill(email);
	await page.getByLabel('비밀번호 · 6자 이상').fill(password);
	await page.getByRole('button', { name: '회원가입' }).click();
	await expect(page).toHaveURL('/');
}

async function openPack(page: Page) {
	await page.goto('/pull');
	await page.getByRole('button', { name: 'LIMKETMON 카드팩 열기' }).click();
	const skip = page.getByRole('button', { name: '연출 건너뛰기' });
	const card = page.getByRole('img', { name: /SSR 카드/ });
	await expect.poll(async () => (await skip.isVisible()) || (await card.isVisible())).toBe(true);
	if (await skip.isVisible()) await skip.click();
	await expect(card).toBeVisible();
}

async function redeemCoupon(page: Page) {
	await page.goto('/coupon');
	await page.getByLabel('쿠폰 코드').fill('LIMKETMON');
	await page.getByRole('button', { name: '등록' }).click();
	await expect(page.getByText('쿠폰 등록 완료 · 뽑기권 +100')).toBeVisible();
}

test('signup → dashboard → logout → login', async ({ page }) => {
	const email = 'auth-flow@limketmon.test';
	await signup(page, email);
	await expect(page.getByRole('heading', { name: 'LIMKETMON' })).toBeVisible();
	await page.getByRole('button', { name: '로그아웃' }).click();
	await expect(page).toHaveURL(/\/login/);
	await page.getByLabel('이메일').fill(email);
	await page.getByLabel('비밀번호').fill(password);
	await page.getByRole('button', { name: '로그인', exact: true }).click();
	await expect(page).toHaveURL('/');
});

test('new user uses the daily free pull exactly once', async ({ page }) => {
	await signup(page, 'daily-pull@limketmon.test');
	await expect(page.getByText('가능', { exact: true })).toBeVisible();
	await openPack(page);
	await expect(page.getByText('오늘의 무료 뽑기 사용')).toBeVisible();
	await page.goto('/');
	await expect(page.getByText('완료', { exact: true })).toBeVisible();
});

test('coupon adds 100 credits and rejects a second redemption', async ({ page }) => {
	await signup(page, 'coupon-flow@limketmon.test');
	await redeemCoupon(page);
	await expect(page.getByText('현재 보유 뽑기권 100')).toBeVisible();
	await page.getByLabel('쿠폰 코드').fill('LIMKETMON');
	await page.getByRole('button', { name: '등록' }).click();
	await expect(page.getByText('이미 사용한 쿠폰입니다.')).toBeVisible();
	await expect(page.getByText('현재 보유 뽑기권 100')).toBeVisible();
});

test('credit pull decreases credits and increments duplicate quantity', async ({ page }) => {
	await signup(page, 'credit-flow@limketmon.test');
	await redeemCoupon(page);
	await openPack(page);
	await page.getByRole('button', { name: '다시 뽑기' }).click();
	await page.getByRole('button', { name: 'LIMKETMON 카드팩 열기' }).click();
	await page.getByRole('button', { name: '연출 건너뛰기' }).click();
	await expect(page.getByText('남은 뽑기권 99')).toBeVisible();
	await expect(page.getByText('보유 ×2')).toBeVisible();
});

test('owned collection card opens an accessible modal and exports a 1080×1920 story', async ({ page }) => {
	await signup(page, 'collection-flow@limketmon.test');
	await openPack(page);
	await page.goto('/collection');
	const ownedCard = page.getByRole('button', { name: /상세 보기/ }).first();
	await expect(ownedCard).toBeVisible();
	await ownedCard.click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	await expect(page.getByRole('button', { name: '카드 상세 닫기' })).toBeFocused();

	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: '스토리 공유' }).click();
	const download = await downloadPromise;
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	const png = Buffer.concat(chunks);
	expect(png.readUInt32BE(16)).toBe(1080);
	expect(png.readUInt32BE(20)).toBe(1920);

	await page.getByRole('button', { name: '카드 상세 닫기' }).click();
	await expect(dialog).toBeHidden();
});

test('mobile and desktop routes have no horizontal overflow', async ({ page }) => {
	await signup(page, 'responsive-flow@limketmon.test');
	for (const viewport of [
		{ width: 320, height: 568 },
		{ width: 375, height: 667 },
		{ width: 390, height: 844 },
		{ width: 430, height: 932 },
		{ width: 768, height: 1024 },
		{ width: 1280, height: 800 },
		{ width: 844, height: 390 }
	]) {
		await page.setViewportSize(viewport);
		for (const route of ['/', '/pull', '/collection', '/coupon']) {
			await page.goto(route);
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
				`${route} overflows at ${viewport.width}×${viewport.height}`
			).toBe(true);
		}
	}
});
