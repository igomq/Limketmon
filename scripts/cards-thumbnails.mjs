import { createRequire } from 'node:module';
import { readdir, stat } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const req = createRequire(import.meta.url);
const nextPkg = req.resolve('next/package.json');
const sharp = createRequire(nextPkg)('sharp');

const CARDS_DIR = path.resolve(process.cwd(), 'public/cards');
const THUMBS_DIR = path.resolve(CARDS_DIR, 'thumbs');

export async function generateThumbnails() {
  if (!existsSync(THUMBS_DIR)) {
    mkdirSync(THUMBS_DIR, { recursive: true });
  }

  const entries = await readdir(CARDS_DIR);
  const imageFiles = [];

  for (const entry of entries) {
    if (entry === 'thumbs') continue;
    const fullPath = path.join(CARDS_DIR, entry);
    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) continue;
    if (/\.(jpg|jpeg|png|webp|gif)$/i.test(entry)) {
      imageFiles.push(entry);
    }
  }

  imageFiles.sort();
  const results = [];
  for (const file of imageFiles) {
    const inputPath = path.join(CARDS_DIR, file);
    const baseName = path.parse(file).name;
    const outputPath = path.join(THUMBS_DIR, `${baseName}.webp`);

    await sharp(inputPath)
      .resize({ width: 480, withoutEnlargement: true })
      .webp({ quality: 76 })
      .toFile(outputPath);

    const meta = await sharp(outputPath).metadata();
    const outStat = await stat(outputPath);
    results.push({ name: `${baseName}.webp`, width: meta.width, height: meta.height, size: outStat.size });
  }

  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  generateThumbnails().then((res) => {
    console.log(`Generated and verified ${res.length} thumbnails.`);
  }).catch((err) => {
    console.error('Failed to generate thumbnails:', err);
    process.exit(1);
  });
}
