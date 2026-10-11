import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { validateEmail, validateNewPassword } from "./validation.js";

export async function readAdminCredentials(): Promise<{ email: string; password: string }> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("An interactive terminal is required");
  }
  let hidden = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (hidden) callback();
      else process.stdout.write(chunk, callback);
    },
  });
  const terminal = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  function question(prompt: string): Promise<string> {
    if (hidden) process.stdout.write(prompt);
    return new Promise((resolve, reject) => {
      function cancel() {
        terminal.removeListener("SIGINT", cancel);
        terminal.removeListener("close", cancel);
        reject(new Error("Admin input cancelled"));
        terminal.close();
      }
      terminal.once("SIGINT", cancel);
      terminal.once("close", cancel);
      terminal.question(prompt, (answer) => {
        terminal.removeListener("SIGINT", cancel);
        terminal.removeListener("close", cancel);
        if (hidden) process.stdout.write("\n");
        resolve(answer);
      });
    });
  }
  try {
    const email = validateEmail(await question("Admin email: "));
    hidden = true;
    const password = validateNewPassword(await question("Password (hidden): "));
    const confirmation = await question("Confirm password (hidden): ");
    if (password !== confirmation) throw new Error("Passwords do not match");
    return { email, password };
  } finally {
    terminal.close();
    output.end();
  }
}
