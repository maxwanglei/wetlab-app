/** Who the specs sign in as. Against a deployment, set E2E_EMAIL and E2E_PASSWORD to a real account. */
export const E2E_EMAIL = process.env.E2E_EMAIL ?? "demo@example.org";
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? "e2e demo password";
