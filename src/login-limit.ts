const windowMs = 15 * 60 * 1000;
type Counter = { count: number; expiresAt: number };

export function createLoginLimit() {
  const attempts = new Map<string, Counter>();
  const failures = new Map<string, Counter>();

  function counter(counters: Map<string, Counter>, key: string, now: number) {
    for (const [entry, value] of counters) {
      if (value.expiresAt <= now) counters.delete(entry);
    }
    let value = counters.get(key);
    if (!value) {
      value = { count: 0, expiresAt: now + windowMs };
      counters.set(key, value);
    }
    return value;
  }

  return {
    check(ip: string, email: string, now: number): number {
      const value = counter(attempts, ip, now);
      if (value.count >= 30) return Math.ceil((value.expiresAt - now) / 1000);
      value.count++;
      const failed = counter(failures, `${ip}:${email}`, now);
      return failed.count >= 5 ? Math.ceil((failed.expiresAt - now) / 1000) : 0;
    },
    fail(ip: string, email: string, now: number): void {
      counter(failures, `${ip}:${email}`, now).count++;
    },
  };
}
