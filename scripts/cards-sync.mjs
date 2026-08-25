/** Validate curated metadata and copy byte-identical artwork into public/cards. */
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imagesDir = path.join(project, 'images');
const outDir = path.join(project, 'public', 'cards');
const manifestPath = path.join(project, 'lib', 'data', 'cards.curated.json');
const supported = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);
const canonical = /^limsingyu-v(\d{3})\.(?:jpe?g|png|webp|avif|gif)$/;
const rarities = new Set(['N', 'R', 'SR', 'SSR', 'UR']);

const files = (await readdir(imagesDir))
	.filter((file) => supported.has(path.extname(file).toLowerCase()))
	.sort();
const { cards = [] } = JSON.parse(await readFile(manifestPath, 'utf8'));
const known = new Set(cards.map((card) => card.sourceName));
const versions = new Set(cards.map((card) => card.version));
let nextVersion = Math.max(0, ...versions) + 1;
const uncurated = files.filter((file) => !known.has(file));

if (uncurated.length) {
	console.error(`${uncurated.length} new image(s) require visual curation:`);
	uncurated.forEach((file) => {
		const match = canonical.exec(file);
		let suggested = file;
		if (match && !versions.has(Number(match[1]))) versions.add(Number(match[1]));
		else {
			while (versions.has(nextVersion)) nextVersion++;
			suggested = `limsingyu-v${String(nextVersion).padStart(3, '0')}${path.extname(file).toLowerCase()}`;
			versions.add(nextVersion++);
		}
		console.error(`- ${file} -> ${suggested}`);
	});
	process.exit(1);
}

const errors = [];
for (const field of ['id', 'version', 'imageKey', 'sourceName']) {
	const values = cards.map((card) => card[field]);
	if (new Set(values).size !== values.length) errors.push(`duplicate ${field}`);
}
for (const card of cards) {
	const version = String(card.version).padStart(3, '0');
	if (!Number.isInteger(card.version) || card.version < 1) errors.push(`${card.id}: invalid version`);
	if (card.id !== `imsingyu-v${version}`) errors.push(`${card.id}: invalid id`);
	if (!canonical.test(card.imageKey) || !card.imageKey.startsWith(`limsingyu-v${version}.`)) errors.push(`${card.id}: invalid imageKey`);
	if (card.sourceName !== card.imageKey) errors.push(`${card.id}: sourceName/imageKey mismatch`);
	if (!rarities.has(card.rarity)) errors.push(`${card.id}: invalid rarity`);
	for (const stat of ['attack', 'defense', 'luck']) {
		if (!Number.isInteger(card[stat]) || card[stat] < 1 || card[stat] > 100) errors.push(`${card.id}: invalid ${stat}`);
	}
	for (const field of ['name', 'alias', 'skillName', 'skillDescription', 'flavorText']) {
		if (typeof card[field] !== 'string' || !card[field].trim()) errors.push(`${card.id}: missing ${field}`);
	}
	if (!Array.isArray(card.visualTags) || card.visualTags.some((tag) => typeof tag !== 'string' || !tag)) errors.push(`${card.id}: invalid visualTags`);
}
for (const card of cards) if (!files.includes(card.sourceName)) errors.push(`${card.id}: missing source image`);
if (cards.length !== files.length) errors.push(`image/card count mismatch (${files.length}/${cards.length})`);
if (errors.length) {
	console.error(errors.join('\n'));
	process.exit(1);
}

await mkdir(outDir, { recursive: true });
await Promise.all(cards.map((card) => copyFile(path.join(imagesDir, card.sourceName), path.join(outDir, card.imageKey))));

const spread = Object.fromEntries([...rarities].map((rarity) => [rarity, cards.filter((card) => card.rarity === rarity).length]));
console.log(`[cards:sync] curated ${cards.length}/${files.length}; metadata unchanged`);
console.log('[cards:sync] rarity spread:', JSON.stringify(spread));
