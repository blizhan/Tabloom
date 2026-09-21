export interface AccessibilityEvidence { readonly keyboardOrder: readonly string[]; readonly focusedError: boolean; readonly paginated: boolean; readonly statusLive: boolean; }
export function assertAccessible(evidence: AccessibilityEvidence): void { if (!evidence.keyboardOrder.length || !evidence.focusedError || !evidence.paginated || !evidence.statusLive) throw new Error("Workbench accessibility evidence is incomplete"); }

export interface WorkbenchAccessibilityReport { readonly status: "passed" | "failed" | "not-run"; readonly evidence: AccessibilityEvidence; readonly details: readonly Record<string, unknown>[]; }

/** Lightweight browser accessibility smoke for the actual product shell. It
 * checks keyboard-reachable controls, an inline source error, the capped
 * preview semantics and the live operation status rather than relying on a
 * screenshot or a third-party accessibility score. */
export async function runWorkbenchAccessibility(): Promise<WorkbenchAccessibilityReport> {
  const controls = [...document.querySelectorAll<HTMLElement>("button, input, select, textarea")].filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0);
  const keyboardOrder = controls.map((element) => element.id || element.getAttribute("aria-label") || element.tagName.toLowerCase());
  const dialog = document.querySelector<HTMLDialogElement>("#source-dialog");
  let focusedError = false;
  if (dialog) {
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    const form = dialog.querySelector<HTMLFormElement>("#source-form");
    const name = dialog.querySelector<HTMLInputElement>("#source-name");
    if (name) { name.value = ""; name.focus(); }
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const error = dialog.querySelector<HTMLElement>("[role='alert']");
    focusedError = Boolean(error && !error.hidden && (document.activeElement === name || document.activeElement === error));
    if (typeof dialog.close === "function") dialog.close(); else dialog.removeAttribute("open");
  }
  const statusLive = Boolean(document.querySelector("[aria-live='polite']") || document.querySelector("[role='status']"));
  const paginated = Boolean(document.querySelector("[role='progressbar']") || document.querySelector("[data-pagination]") || document.querySelector(".table-wrap"));
  const evidence = { keyboardOrder, focusedError, paginated, statusLive };
  try { assertAccessible(evidence); return { status: "passed", evidence, details: [{ controls: controls.length, labels: controls.map((control) => ({ id: control.id, aria: control.getAttribute("aria-label"), labelledBy: control.getAttribute("aria-labelledby") })) }] }; }
  catch (error) { return { status: "failed", evidence, details: [{ error: error instanceof Error ? error.message : String(error), controls: controls.length }] }; }
}
