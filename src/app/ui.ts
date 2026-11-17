// Small DOM helpers, modal dialogs and display formatting.

type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') node.addEventListener(k.replace(/^on/, ''), v);
    else if (k === 'class') node.className = String(v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "17 Nov 2026, 14:30", independent of the browser locale. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

interface ModalButton {
  label: string;
  value: string;
  kind?: 'primary' | 'danger';
}

export interface ModalOptions {
  title: string;
  body?: string;
  input?: { value: string; placeholder?: string; maxLength?: number; type?: string };
  buttons: ModalButton[];
}

/** Resolves with the clicked button's value (and the input text), or null on Esc. */
export function modal(opts: ModalOptions): Promise<{ button: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = opts.input
      ? el('input', {
          class: 'modal-input',
          type: opts.input.type ?? 'text',
          value: opts.input.value,
          placeholder: opts.input.placeholder,
          maxlength: opts.input.maxLength,
          'data-testid': 'modal-input',
        })
      : null;
    const close = (result: { button: string; text: string } | null) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const primary = opts.buttons.find((b) => b.kind === 'primary') ?? opts.buttons[0];
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Enter') {
        e.stopPropagation();
        e.preventDefault();
        close({ button: primary.value, text: input?.value ?? '' });
      }
    };
    const overlay = el(
      'div',
      { class: 'modal-overlay' },
      el(
        'div',
        { class: 'modal', role: 'dialog', 'aria-label': opts.title },
        el('h2', {}, opts.title),
        opts.body ? el('p', {}, opts.body) : null,
        input,
        el(
          'div',
          { class: 'modal-buttons' },
          ...opts.buttons.map((b) =>
            el('button', { class: `btn ${b.kind ?? ''}`, onclick: () => close({ button: b.value, text: input?.value ?? '' }) }, b.label),
          ),
        ),
      ),
    );
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    (input ?? overlay.querySelector<HTMLButtonElement>('.btn.primary') ?? overlay.querySelector('button'))?.focus();
    if (input) input.select();
  });
}

export async function confirmBox(title: string, body: string, yes: string, danger = false): Promise<boolean> {
  const r = await modal({
    title,
    body,
    buttons: [
      { label: 'Cancel', value: 'no' },
      { label: yes, value: 'yes', kind: danger ? 'danger' : 'primary' },
    ],
  });
  return r?.button === 'yes';
}

export async function promptBox(title: string, value: string, ok = 'Save'): Promise<string | null> {
  const r = await modal({
    title,
    input: { value, maxLength: 60 },
    buttons: [
      { label: 'Cancel', value: 'no' },
      { label: ok, value: 'yes', kind: 'primary' },
    ],
  });
  return r?.button === 'yes' ? r.text.trim() : null;
}

export function toast(message: string): void {
  const t = el('div', { class: 'toast', role: 'status' }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickJsonFile(): Promise<unknown | null> {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept: '.json,.2dhr,application/json', 'data-testid': 'file-input' });
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return resolve(null);
      try {
        resolve(JSON.parse(await f.text()));
      } catch {
        resolve({ __bad: true });
      }
    });
    document.body.append(input);
    input.click();
  });
}
