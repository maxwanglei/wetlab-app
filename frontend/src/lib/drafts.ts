/** What a form holds while it is being filled in: every input as the text typed, keyed by its path in
 * the request body ("lot_number", "condition.ph", "arms.0.concentration"). The same paths key the
 * problems found here and the ones the API reports in a 422, so both land on the same field. */
export type FieldErrors = Readonly<Record<string, string>>;

export type Parsed<T> = { ok: true; body: T } | { ok: false; errors: FieldErrors };

const DECIMAL = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)(e[+-]?\d+)?$/i;

/** Reads typed text into request values, collecting a problem per path as it goes. */
export function draftReader() {
  const errors: Record<string, string> = {};
  return {
    errors,
    fail(path: string, message: string) {
      errors[path] ??= message;
    },
    /** Trimmed text, or null when left empty. */
    text(path: string, raw: string, options: { required?: boolean } = {}): string | null {
      const value = raw.trim();
      if (value) return value;
      if (options.required) errors[path] ??= "Required.";
      return null;
    },
    /** A number typed with a decimal point or comma ("0.5", "0,5"), or null when left empty. */
    number(path: string, raw: string, options: { required?: boolean } = {}): number | null {
      const value = raw.trim();
      if (!value) {
        if (options.required) errors[path] ??= "Required.";
        return null;
      }
      if (!DECIMAL.test(value)) {
        errors[path] ??= "Enter a number, such as 0.5.";
        return null;
      }
      const parsed = Number(value.replace(",", "."));
      if (!Number.isFinite(parsed) || (parsed === 0 && /[1-9]/.test(value.split(/[eE]/)[0] ?? ""))) {
        errors[path] ??= "Enter a number within the supported range.";
        return null;
      }
      return parsed;
    },
    /** An id chosen in a select, or null for its empty option. */
    id(raw: string): number | null {
      return raw === "" ? null : Number(raw);
    },
    result<T>(body: T): Parsed<T> {
      return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, body };
    },
  };
}

/** The text a number field starts from when editing a saved value. */
export function numberText(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
