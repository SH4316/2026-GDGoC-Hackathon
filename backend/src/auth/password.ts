import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const options = { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const keyLength = 64;

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  const [salt, expected] = hash.split(':');
  const key = await deriveKey(password, Buffer.from(salt, 'hex'));
  return timingSafeEqual(key, Buffer.from(expected, 'hex'));
}
