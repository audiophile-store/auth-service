import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "../src/passwords.js";

const password = "Synthetic-Demo-Password!";

test("hash uses Argon2id version 19 with the agreed memory, iterations and parallelism", async () => {
  const hash = await hashPassword(password);
  assert.match(hash, /^\$argon2id\$v=19\$/);
  const parameters = hash.split("$")[3];
  assert.ok(parameters);
  assert.deepEqual(Object.fromEntries(parameters.split(",").map((pair) => pair.split("="))), {
    m: "65536",
    t: "3",
    p: "1",
  });
  assert.equal(hash.includes(password), false);
  const salt = hash.split("$")[4];
  assert.ok(salt);
  assert.ok(Buffer.from(salt, "base64").length >= 16);
});

test("identical passwords produce different salts and hashes", async () => {
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.notEqual(first.split("$")[4], second.split("$")[4]);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(password, second), true);
});

test("correct password verifies successfully", async () => {
  const hash = await hashPassword(password);
  assert.equal(await verifyPassword(password, hash), true);
});

test("incorrect password returns false", async () => {
  const hash = await hashPassword(password);
  assert.equal(await verifyPassword("Wrong-Synthetic-Password!", hash), false);
});

test("hashing preserves password whitespace, case and Unicode", async () => {
  const original = "  Synthetic-\u010d-Password!  ";
  const hash = await hashPassword(original);
  assert.equal(await verifyPassword(original, hash), true);
  assert.equal(await verifyPassword(original.trim(), hash), false);
  assert.equal(await verifyPassword(original.toLowerCase(), hash), false);
});

for (const [name, hash] of [
  ["empty", ""],
  ["plain text", "not-a-password-hash"],
  ["malformed Argon2id", "$argon2id$invalid"],
  ["different algorithm", "$2b$12$synthetic"],
]) {
  test(`invalid stored hash (${name}) throws rather than returning false`, async () => {
    await assert.rejects(() => verifyPassword(password, hash), Error);
  });
}
