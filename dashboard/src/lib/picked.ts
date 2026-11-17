/**
 * Which company was open last in this browser, so the dashboard opens on it
 * again: after a reload, and when Stripe sends the person back from checkout.
 */

const PICKED = 'minemuster.office.company';

export function remembered(): string | null {
  try {
    return window.localStorage.getItem(PICKED);
  } catch {
    return null;
  }
}

export function remember(id: string): void {
  try {
    window.localStorage.setItem(PICKED, id);
  } catch {
    // A browser that keeps nothing still works; it just opens the first company.
  }
}
