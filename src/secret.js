import { timingSafeEqual } from 'node:crypto';

// Comparare in timp constant -- altfel un atacator ar putea deduce secretul caracter cu
// caracter din cat de repede raspunde un `!==` obisnuit (timing attack). Lungimi diferite
// tratate explicit: timingSafeEqual arunca in loc sa intoarca false daca buffer-ele nu au
// aceeasi lungime. Folosit de ambele functii Vercel (webhook + notify-guests).
export function isValidSecret(received, expected) {
  if (!received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
