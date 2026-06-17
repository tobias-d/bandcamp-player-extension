export function dom<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<HTMLElement | string> = []
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);

  Object.entries(attrs).forEach(([key, value]) => {
    element.setAttribute(key, value);
  });

  children.forEach((child) => {
    if (typeof child === 'string') {
      element.appendChild(document.createTextNode(child));
      return;
    }
    element.appendChild(child);
  });

  return element;
}

export function injectStylesheet(id: string, cssText: string): void {
  const existing = document.getElementById(id);
  if (existing) {
    if (existing.textContent !== cssText) {
      existing.textContent = cssText;
    }
    return;
  }
  const style = document.createElement('style');
  style.id = id;
  style.textContent = cssText;
  document.head.appendChild(style);
}

export function setText(el: HTMLElement, text: string): void {
  el.textContent = text;
}
