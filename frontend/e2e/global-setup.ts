import { execFileSync } from "node:child_process";
import path from "node:path";
import { E2E_EMAIL, E2E_PASSWORD } from "./accounts";

/** Reloads the demo database so every run starts from the seeded story (outlier included, nothing saved).
 * The seed refuses any database whose name does not end in _demo or _test. Set E2E_SKIP_SEED=1 when
 * BASE_URL points at a deployment whose database you reseed yourself. */
export default function globalSetup() {
  if (process.env.E2E_SKIP_SEED === "1") return;
  const backend = path.resolve(import.meta.dirname, "../../backend");
  execFileSync("uv", ["run", "python", "-m", "app.seed.demo"], { cwd: backend, stdio: "inherit" });
  // The seed gives no one a password; the specs sign in as its demo member, made an admin here.
  execFileSync("uv", ["run", "python", "-m", "scripts.add_member", "--email", E2E_EMAIL, "--admin", "--password-stdin"], {
    cwd: backend,
    input: `${E2E_PASSWORD}\n`,
    stdio: ["pipe", "inherit", "inherit"],
  });
}
