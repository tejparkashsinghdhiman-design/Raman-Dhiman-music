// A screen lock for Drafts. This keeps casual eyes out; it is NOT encryption.
// The PIN is stored only as a salted PBKDF2 hash on this device.
import { ls } from './util.js';

const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(pin, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, key, 256);
  return b64(new Uint8Array(bits));
}

let unlocked = false;
export const hasPin = () => !!ls.get('pin', null);
export const isUnlocked = () => !hasPin() || unlocked;

export async function setPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  ls.set('pin', { salt: b64(salt), hash: await derive(pin, salt) });
  unlocked = true;
}
export async function verifyPin(pin) {
  const rec = ls.get('pin', null);
  if (!rec) return true;
  const ok = (await derive(pin, unb64(rec.salt))) === rec.hash;
  if (ok) unlocked = true;
  return ok;
}
export function removePin() { ls.del('pin'); unlocked = true; }
export function relock() { unlocked = false; }
