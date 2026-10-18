import { expect, test } from "@playwright/test";

/**
 * End-to-end smoke test of the full editor flow against the production
 * build: generate a draft, approve it explicitly, then verify the explicit
 * rejection path. Uses the offline heuristic provider (no credentials).
 */

test("resolvable headline produces a draft that can be explicitly approved", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Headline to Market" })).toBeVisible();

  await page.getByRole("button", { name: "Load resolvable example" }).click();
  await page.getByRole("button", { name: "Generate draft" }).click();

  const detail = page.getByTestId("market-detail");
  await expect(detail).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("draft-question")).toContainText("RBI");
  await expect(page.getByTestId("generation-provenance")).toContainText("offline heuristic fallback");

  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await expect(page.getByTestId("confirm-dialog")).toContainText("no external market");
  await page.getByTestId("confirm-button").click();

  await expect(page.getByTestId("action-notice")).toContainText("does not publish");
  await expect(page.getByTestId("approve-button")).toBeDisabled();
});

test("vague headline produces an explicit rejection, not a market", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Load rejection example" }).click();
  await page.getByRole("button", { name: "Generate draft" }).click();

  const panel = page.getByTestId("unresolvable-panel");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("rejection-reason")).toContainText("subjective");
  await expect(page.getByTestId("market-detail")).toHaveCount(0);
});
