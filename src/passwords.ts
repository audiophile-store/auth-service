import { argon2id, hash, verify } from "argon2";

export function hashPassword(password: string): Promise<string> {
  return hash(password, {
    type: argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  if (!passwordHash.startsWith("$argon2id$")) {
    throw new Error("Invalid stored Argon2id password hash");
  }
  return verify(passwordHash, password);
}
