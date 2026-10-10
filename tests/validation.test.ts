import assert from "node:assert/strict";
import test from "node:test";
import {
  validateEmail,
  validateLoginRequest,
  validateNewPassword,
} from "../src/validation.js";

const validEmail = "admin@example.com";
const validPassword = "DemoPass!";
const longestEmail = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`;

test("email is trimmed and lowercased", () => {
  assert.equal(validateEmail(" \tAdmin@EXAMPLE.COM\n"), validEmail);
});

test("email supports common plus and dotted addresses", () => {
  assert.equal(validateEmail("Admin.Name+Demo@Sub.Example.COM"), "admin.name+demo@sub.example.com");
});

test("email accepts exactly 254 normalized characters", () => {
  assert.equal(longestEmail.length, 254);
  assert.equal(validateEmail(` ${longestEmail} `), longestEmail);
});

const invalidEmails: Array<[string, unknown]> = [
  ["missing", undefined],
  ["null", null],
  ["number", 123],
  ["boolean", true],
  ["object", {}],
  ["array", [validEmail]],
  ["empty", ""],
  ["blank", " \t\n"],
  ["missing at sign", "admin.example.com"],
  ["missing local part", "@example.com"],
  ["missing domain", "admin@"],
  ["multiple at signs", "admin@@example.com"],
  ["internal whitespace", "ad min@example.com"],
  ["domain whitespace", "admin@exa mple.com"],
  ["missing domain suffix", "admin@example"],
  ["empty domain label", "admin@example..com"],
  ["leading domain hyphen", "admin@-example.com"],
  ["trailing domain hyphen", "admin@example-.com"],
  ["leading local dot", ".admin@example.com"],
  ["trailing local dot", "admin.@example.com"],
  ["consecutive local dots", "admin..name@example.com"],
  ["display name", "Admin <admin@example.com>"],
  ["255 normalized characters", `a${longestEmail}`],
];
for (const [name, value] of invalidEmails) {
  test(`email rejects ${name}`, () => {
    assert.throws(() => validateEmail(value), { message: "Invalid email" });
  });
}

for (const length of [8, 128]) {
  test(`new password accepts the ${length}-character boundary`, () => {
    const password = `A!${"a".repeat(length - 2)}`;
    assert.equal(validateNewPassword(password), password);
  });
}

test("new password preserves leading and trailing spaces", () => {
  const password = "  DemoPass!  ";
  assert.equal(validateNewPassword(password), password);
});

test("new password does not require digits or lowercase letters", () => {
  assert.equal(validateNewPassword("ABCDEFG!"), "ABCDEFG!");
});

test("new password supports Unicode uppercase letters and punctuation", () => {
  const password = "\u010cabcdef!";
  assert.equal(validateNewPassword(password), password);
});

test("new password counts Unicode code points, not UTF-16 units", () => {
  const password = `A!${"\u{1f512}".repeat(126)}`;
  assert.equal(validateNewPassword(password), password);
  assert.throws(() => validateNewPassword(`A!${"\u{1f512}".repeat(127)}`), {
    message: "Invalid password",
  });
  assert.throws(() => validateNewPassword(`A!${"\u{1f512}".repeat(5)}`), {
    message: "Invalid password",
  });
});

for (const symbol of ["!", "@", "#", "$", "%", "^", "&", "*", "-", "_", ".", "+", "=", "\u{1f512}"]) {
  test(`new password accepts punctuation/symbol ${JSON.stringify(symbol)}`, () => {
    const password = `Abcdefg${symbol}`;
    assert.equal(validateNewPassword(password), password);
  });
}

const invalidPasswords: Array<[string, unknown]> = [
  ["missing", undefined],
  ["null", null],
  ["number", 123],
  ["boolean", false],
  ["object", {}],
  ["array", [validPassword]],
  ["empty", ""],
  ["seven characters", "Abcdef!"],
  ["129 characters", `A!${"a".repeat(127)}`],
  ["no uppercase", "abcdefg!"],
  ["no special symbol", "Abcdefg1"],
  ["space instead of symbol", "Abcdefg "],
  ["tab instead of symbol", "Abcdefg\t"],
];
for (const [name, value] of invalidPasswords) {
  test(`new password rejects ${name}`, () => {
    assert.throws(() => validateNewPassword(value), { message: "Invalid password" });
  });
}

test("login normalizes only email and returns a fresh object", () => {
  const body = Object.freeze({ email: " Admin@Example.COM ", password: "  DemoPass!  " });
  const result = validateLoginRequest(body);
  assert.deepEqual(result, { email: validEmail, password: body.password });
  assert.notEqual(result, body);
  assert.equal(body.email, " Admin@Example.COM ");
});

for (const password of ["a", "lowercase", "ABCDEFGH", "12345678", " ", "  short  "]) {
  test(`login does not impose new-password rules (${JSON.stringify(password)})`, () => {
    assert.equal(validateLoginRequest({ email: validEmail, password }).password, password);
  });
}

test("login accepts 128 Unicode characters without modifying the password", () => {
  const password = "\u{1f512}".repeat(128);
  assert.equal(validateLoginRequest({ email: validEmail, password }).password, password);
});

const invalidLoginBodies: Array<[string, unknown, string]> = [
  ["missing", undefined, "Login must be an object"],
  ["null", null, "Login must be an object"],
  ["array", [], "Login must be an object"],
  ["string", "email=admin@example.com", "Login must be an object"],
  ["number", 123, "Login must be an object"],
  ["boolean", true, "Login must be an object"],
  ["empty object", {}, "Invalid email"],
  ["missing email", { password: validPassword }, "Invalid email"],
  ["invalid email", { email: "not-an-email", password: validPassword }, "Invalid email"],
  ["missing password", { email: validEmail }, "Invalid password"],
  ["empty password", { email: validEmail, password: "" }, "Invalid password"],
  ["null password", { email: validEmail, password: null }, "Invalid password"],
  ["number password", { email: validEmail, password: 123 }, "Invalid password"],
  ["object password", { email: validEmail, password: {} }, "Invalid password"],
  ["array password", { email: validEmail, password: ["secret"] }, "Invalid password"],
  ["long password", { email: validEmail, password: "a".repeat(129) }, "Invalid password"],
  ["extra role", { email: validEmail, password: validPassword, role: "admin" }, "Login contains unsupported fields"],
  ["extra token", { email: validEmail, password: validPassword, token: "secret" }, "Login contains unsupported fields"],
];
for (const [name, body, message] of invalidLoginBodies) {
  test(`login rejects ${name} without returning input in errors`, () => {
    assert.throws(() => validateLoginRequest(body), { message });
  });
}

test("login ignores inherited credentials rather than accepting them", () => {
  const body = Object.create({ email: validEmail, password: validPassword });
  assert.throws(() => validateLoginRequest(body), { message: "Invalid email" });
});

test("login safely rejects JSON prototype fields", () => {
  const body: unknown = JSON.parse(
    '{"email":"admin@example.com","password":"DemoPass!","__proto__":{"role":"admin"}}',
  );
  assert.throws(() => validateLoginRequest(body), { message: "Login contains unsupported fields" });
});
