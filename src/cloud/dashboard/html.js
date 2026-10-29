/** Plantillas HTML con escape automático: todo valor interpolado se escapa salvo el marcado con `raw`. */

class Raw {
  constructor(text) {
    this.text = text;
  }

  toString() {
    return this.text;
  }
}

/** Marca un fragmento ya seguro. */
export const raw = (text) => new Raw(String(text));

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' };

export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

function render(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Raw) return value.text;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(value);
}

/** Etiqueta de plantilla: `html\`<p>${texto}</p>\`` devuelve un fragmento seguro. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Raw(out);
}

/** Texto final de un fragmento. */
export const toText = (fragment) => (fragment instanceof Raw ? fragment.text : escapeHtml(fragment));
