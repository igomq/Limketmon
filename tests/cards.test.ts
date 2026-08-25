import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import manifest from '../lib/data/cards.curated.json' with { type: 'json' };

const root = process.cwd();
const imagesDir = path.join(root, 'images');
const publicDir = path.join(root, 'public', 'cards');
const manifestPath = path.join(root, 'lib', 'data', 'cards.curated.json');
const supported = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);
const rarities = new Set(['N', 'R', 'SR', 'SSR', 'UR']);
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

test('every image has one valid curated card and byte-identical public artwork', async () => {
  const files = (await readdir(imagesDir)).filter((file) => supported.has(path.extname(file).toLowerCase())).sort();
  const cards = manifest.cards;
  assert.deepEqual(cards.map((card) => card.sourceName).sort(), files);
  assert.equal(cards.length, 46);

  for (const field of ['id', 'version', 'imageKey'] as const) {
    assert.equal(new Set(cards.map((card) => card[field])).size, cards.length, `${field} must be unique`);
  }
  for (const card of cards) {
    assert.ok(rarities.has(card.rarity));
    assert.equal(card.sourceName, card.imageKey);
    assert.ok(existsSync(path.join(imagesDir, card.imageKey)));
    assert.ok(existsSync(path.join(publicDir, card.imageKey)));
    assert.equal(hash(await readFile(path.join(imagesDir, card.imageKey))), hash(await readFile(path.join(publicDir, card.imageKey))));
    for (const stat of [card.attack, card.defense, card.luck]) assert.ok(Number.isInteger(stat) && stat >= 1 && stat <= 100);
  }
});

test('cards:sync never changes curated metadata', async () => {
  const before = await readFile(manifestPath);
  const { spawnSync } = await import('node:child_process');
  for (let run = 0; run < 2; run++) {
    const result = spawnSync(process.execPath, ['scripts/cards-sync.mjs'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(hash(await readFile(manifestPath)), hash(before));
});

test('runtime code has no pre-rename image references', async () => {
  const oldPrefix = 'Talk' + 'Media_';
  const roots = ['app', 'lib', 'scripts', 'tests'];
  const files = ['README.md', 'package.json'];
  for (const dir of roots) {
    for (const entry of await readdir(path.join(root, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /\.(?:ts|tsx|mjs|json|md|css)$/.test(entry.name)) files.push(path.join(entry.parentPath, entry.name));
    }
  }
  for (const file of files) assert.ok(!(await readFile(path.resolve(root, file), 'utf8')).includes(oldPrefix), file);
});
