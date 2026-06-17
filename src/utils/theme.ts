/**
 * Copy resolved CSS custom-property values from a source element onto a target's inline
 * style. Used by viewport-mounted dialogs/panels that mount outside the panel's stacking
 * context (e.g. on document.body) and therefore cannot inherit its theme tokens.
 */
export function copyThemeVars(
  source: HTMLElement,
  target: HTMLElement,
  vars: readonly string[]
): void {
  const styles = window.getComputedStyle(source);
  for (const variable of vars) {
    const value = styles.getPropertyValue(variable).trim();
    if (value) {
      target.style.setProperty(variable, value);
    }
  }
}
