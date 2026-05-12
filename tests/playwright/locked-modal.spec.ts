import { test, expect, Page } from "@playwright/test";
import { tryDismissIn } from "../../process-queue";

// Each fixture is a self-contained HTML page that simulates one of the failure
// modes I want tryDismissIn to handle. The invariant under test is the same
// for every case: tryDismissIn must return true iff the locked dialog is
// actually hidden afterwards.

async function load(page: Page, html: string): Promise<void> {
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
}

async function dialogVisible(page: Page): Promise<boolean> {
  return page.getByText(/Time Cannot be Locked/i).first().isVisible().catch(() => false);
}

test.describe("tryDismissIn", () => {
  test("closes a proper role=dialog via its CLOSE button", async ({ page }) => {
    await load(
      page,
      `
        <div id="dlg" role="dialog" aria-label="Time Cannot be Locked">
          <h2>Time Cannot be Locked</h2>
          <p>The Tee Time you have selected is currently locked by another user.</p>
          <button onclick="document.getElementById('dlg').remove()">CLOSE</button>
        </div>
      `
    );

    const result = await tryDismissIn(page);

    expect(result).toBe(true);
    expect(await dialogVisible(page)).toBe(false);
  });

  test("closes a dialog without role=dialog by scoping to the heading's container", async ({ page }) => {
    // Repro for the "scope falls back to ctx" bug: a stray Close link
    // elsewhere on the page must not be clicked instead of the real one.
    await load(
      page,
      `
        <a id="footer-close" href="#" onclick="window.__footerClickedAt=Date.now();return false;">Close</a>
        <div class="modal" id="dlg">
          <h2>Time Cannot be Locked</h2>
          <p>The Tee Time you have selected is currently locked by another user.</p>
          <button onclick="document.getElementById('dlg').remove()">CLOSE</button>
        </div>
      `
    );

    const result = await tryDismissIn(page);

    expect(result).toBe(true);
    expect(await dialogVisible(page)).toBe(false);
    // The footer Close link must not have been touched.
    const footerClicked = await page.evaluate(() => (window as unknown as { __footerClickedAt?: number }).__footerClickedAt);
    expect(footerClicked).toBeUndefined();
  });

  test("returns false when CLOSE button does nothing and Escape is ignored", async ({ page }) => {
    // Repro for the "lies about success" bug: every dismissal mechanism is a
    // no-op. The function must report false so the caller can abort instead
    // of falsely claiming subsequent slots are locked.
    await load(
      page,
      `
        <div id="dlg" role="dialog" aria-label="Time Cannot be Locked">
          <h2>Time Cannot be Locked</h2>
          <p>The Tee Time you have selected is currently locked by another user.</p>
          <button onclick="event.preventDefault()">CLOSE</button>
        </div>
        <script>
          // Swallow Escape so the keyboard fallback also fails.
          window.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.preventDefault(); }, true);
        </script>
      `
    );

    const result = await tryDismissIn(page);

    expect(result).toBe(false);
    expect(await dialogVisible(page)).toBe(true);
  });

  test("retries past a non-closing first candidate when a later one works", async ({ page }) => {
    // Repro for the "first click wins" bug: the role=link "close" doesn't
    // actually close, but the .close button further down the candidate list
    // does. The old code returned true after the link click and gave up.
    await load(
      page,
      `
        <div id="dlg" role="dialog" aria-label="Time Cannot be Locked">
          <h2>Time Cannot be Locked</h2>
          <p>The Tee Time you have selected is currently locked by another user.</p>
          <button class="close" aria-label="Close" onclick="document.getElementById('dlg').remove()">x</button>
          <a href="#" onclick="event.preventDefault()">close</a>
        </div>
      `
    );

    const result = await tryDismissIn(page);

    expect(result).toBe(true);
    expect(await dialogVisible(page)).toBe(false);
  });

  test("falls back to Escape when no close target matches", async ({ page }) => {
    await load(
      page,
      `
        <div id="dlg" role="dialog" aria-label="Time Cannot be Locked">
          <h2>Time Cannot be Locked</h2>
          <p>The Tee Time you have selected is currently locked by another user.</p>
        </div>
        <script>
          window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') document.getElementById('dlg').remove();
          });
        </script>
      `
    );

    const result = await tryDismissIn(page);

    expect(result).toBe(true);
    expect(await dialogVisible(page)).toBe(false);
  });

  test("returns false when no locked dialog is present", async ({ page }) => {
    await load(page, `<p>nothing to see here</p>`);

    const result = await tryDismissIn(page);

    expect(result).toBe(false);
  });
});
