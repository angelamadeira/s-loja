import { env } from "cloudflare:test";
import { expect, test } from "vitest";

test("harness expõe os bindings do Worker (pool ligado)", () => {
  expect(env).toBeDefined();
  expect(env.DB).toBeDefined(); // binding D1 do wrangler.jsonc — prova que o pool está ativo
});
