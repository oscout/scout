export function hasTextSelection(): boolean {
  const sel = window.getSelection();
  return sel !== null && sel.toString().trim().length > 0;
}

export function navigateUnlessSelected(fn: () => void): void {
  if (!hasTextSelection()) fn();
}
