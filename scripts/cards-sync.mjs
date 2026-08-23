/**
 * pnpm cards:sync
 * Scans ./images for supported photos, copies them into static/cards/ under a
 * stable versioned key, and appends new cards to the generated manifest.
 * Existing card metadata is never modified. Image conversion/editing never happens.
 * This is a build-time script — the only place node:fs is allowed.
 */
import { readdir, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)); // scripts/
const project = path.resolve(root, '..');
const imagesDir = path.join(project, 'images');
const outDir = path.join(project, 'static', 'cards');
const manifestPath = path.join(project, 'src', 'lib', 'data', 'cards.generated.json');

const SUPPORTED = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

// card-gen is a pure TS module; Node >= 23.6 strips types natively.
const { generateCard, ensureRarityCoverage } = await import('../src/lib/card-gen.ts');

const files = (await readdir(imagesDir))
	.filter((f) => SUPPORTED.has(path.extname(f).toLowerCase()))
	.sort();

const manifest = existsSync(manifestPath)
	? JSON.parse(await readFile(manifestPath, 'utf8'))
	: { generatedAt: null, cards: [] };

const known = new Map(manifest.cards.map((c) => [c.sourceName, c]));
let nextVersion = manifest.cards.reduce((m, c) => Math.max(m, c.version), 0) + 1;

const added = [];
for (const file of files) {
	if (known.has(file)) continue;
	const ext = path.extname(file).toLowerCase();
	const imageKey = `v${String(nextVersion).padStart(3, '0')}${ext}`;
	const card = { ...generateCard({ version: nextVersion, imageKey, sourceName: file }), sourceName: file };
	added.push(card);
	known.set(file, card);
	nextVersion++;
}

ensureRarityCoverage(added);

if (added.length > 0) {
	await mkdir(outDir, { recursive: true });
	for (const file of files) {
		const card = known.get(file);
		await copyFile(path.join(imagesDir, file), path.join(outDir, card.imageKey));
	}
	manifest.cards = [...manifest.cards, ...added].sort((a, b) => a.version - b.version);
	manifest.generatedAt = new Date().toISOString();
	await mkdir(path.dirname(manifestPath), { recursive: true });
	await writeFile(manifestPath, JSON.stringify(manifest, null, '\t') + '\n', 'utf8');
	console.log(`[cards:sync] added ${added.length} new card(s), total ${manifest.cards.length}`);
	const byRarity = manifest.cards.reduce((acc, c) => ((acc[c.rarity] = (acc[c.rarity] ?? 0) + 1), acc), {});
	console.log('[cards:sync] rarity spread:', JSON.stringify(byRarity));
} else {
	console.log(`[cards:sync] no new images, total ${manifest.cards.length}`);
}
