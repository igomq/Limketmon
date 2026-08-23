/**
 * Password hashing with Web Crypto PBKDF2-SHA256. Works in Node, edge
 * runtimes, and browsers — no node:crypto dependency.
 */
const ITERATIONS = 100_000;
const KEY_LENGTH = 32;

function toHex(buf: ArrayBuffer): string {
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function derive(password: string, saltHex: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
		'deriveBits'
	]);
	const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
		key,
		KEY_LENGTH * 8
	);
	return toHex(bits);
}

export async function hashPassword(
	password: string
): Promise<{ hash: string; salt: string }> {
	const salt = toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
	return { hash: await derive(password, salt), salt };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
	const candidate = await derive(password, salt);
	// constant-time-ish compare
	if (candidate.length !== hash.length) return false;
	let diff = 0;
	for (let i = 0; i < candidate.length; i++) diff |= candidate.charCodeAt(i) ^ hash.charCodeAt(i);
	return diff === 0;
}
