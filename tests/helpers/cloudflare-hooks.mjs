// Makes the app's server modules importable by the Node test runner:
// - 'cloudflare:workers' and 'server-only' have no Node equivalent, so they get stubs;
// - the app uses extensionless relative imports (bundler style), Node needs the extension;
// - the app imports JSON without an import attribute, which Node rejects in ESM.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STUBS = new Map([
  ['cloudflare:workers', new URL('./cloudflare-workers.mjs', import.meta.url).href],
  ['server-only', new URL('./server-only.mjs', import.meta.url).href],
  // next/headers only works inside a Next request scope; the stub lets route handlers run in tests.
  ['next/headers', new URL('./next-headers.mjs', import.meta.url).href]
]);

const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '.json'];

export async function resolve(specifier, context, next) {
  const stub = STUBS.get(specifier);
  if (stub) return { url: stub, shortCircuit: true };
  // The app imports 'next/server'; Node needs the explicit file name.
  if (specifier === 'next/server') return next('next/server.js', context);
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.startsWith('file:')) {
    const base = new URL(specifier, context.parentURL);
    for (const extension of EXTENSIONS) {
      const candidate = new URL(base.href + extension);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return {
      format: 'module',
      source: `export default ${readFileSync(fileURLToPath(url), 'utf8')};`,
      shortCircuit: true
    };
  }
  return next(url, context);
}
