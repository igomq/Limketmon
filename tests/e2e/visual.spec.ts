import { expect, test } from '@playwright/test';

test('core mobile surfaces stay visually stable', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/signup');
	await page.getByLabel('이메일').fill('visual@limketmon.test');
	await page.getByLabel('비밀번호 · 6자 이상').fill('cardpack123');
	await page.getByRole('button', { name: '회원가입' }).click();
	const nav = await page.getByRole('navigation', { name: '주요 메뉴' }).boundingBox();
	expect(nav?.y).toBeGreaterThan(740);
	await expect(page).toHaveScreenshot('dashboard.png', {
		animations: 'disabled',
		maxDiffPixelRatio: 0.015
	});

	await page.goto('/pull');
	await expect(page).toHaveScreenshot('pack.png', {
		animations: 'disabled',
		maxDiffPixelRatio: 0.015
	});

	await page.goto('/coupon');
	await expect(page).toHaveScreenshot('coupon.png', {
		animations: 'disabled',
		maxDiffPixelRatio: 0.015
	});

	await page.goto('/pull');
	await page.getByRole('button', { name: 'LIMKETMON 카드팩 열기' }).click();
	await page.getByRole('button', { name: '연출 건너뛰기' }).click();
	await page.goto('/collection');
	await page.getByRole('button', { name: /상세 보기/ }).click();
	await expect(page.getByRole('dialog')).toBeVisible();
	await expect(page).toHaveScreenshot('ssr-card-detail.png', {
		animations: 'disabled',
		maxDiffPixelRatio: 0.02
	});
});
