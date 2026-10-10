export function validateEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Invalid email");
  }
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)) {
    throw new Error("Invalid email");
  }
  return email;
}

function readPassword(value: unknown): string {
  if (typeof value !== "string" || value.length > 256) {
    throw new Error("Invalid password");
  }
  const length = Array.from(value).length;
  if (length === 0 || length > 128) {
    throw new Error("Invalid password");
  }
  return value;
}

export function validateNewPassword(value: unknown): string {
  const password = readPassword(value);
  if (Array.from(password).length < 8 || !/\p{Lu}/u.test(password) || !/[\p{P}\p{S}]/u.test(password)) {
    throw new Error("Invalid password");
  }
  return password;
}

export function validateLoginRequest(body: unknown): { email: string; password: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Login must be an object");
  }
  const object: Record<string, unknown> = { ...body };
  if (Object.keys(object).some((key) => key !== "email" && key !== "password")) {
    throw new Error("Login contains unsupported fields");
  }
  return {
    email: validateEmail(object.email),
    password: readPassword(object.password),
  };
}
