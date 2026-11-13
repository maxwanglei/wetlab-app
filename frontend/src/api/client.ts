import createClient, { type Middleware } from "openapi-fetch";
import type { components, paths } from "./schema";

export type Schemas = components["schemas"];

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const csrfHeaders: Middleware = {
  onRequest({ request }) {
    if (MUTATING_METHODS.has(request.method)) {
      request.headers.set("X-Requested-With", "wetlab");
      if (!request.headers.has("Content-Type")) request.headers.set("Content-Type", "application/json");
    }
    return request;
  },
};

/** A request refused for want of a session sends the browser to the sign-in page, which returns here after. */
const signInWhenSignedOut: Middleware = {
  onResponse({ response, request }) {
    const signingIn = new URL(request.url).pathname === "/api/auth/login";
    if (response.status === 401 && !signingIn && window.location.pathname !== "/login") {
      const here = window.location.pathname + window.location.search;
      window.location.assign(`/login?next=${encodeURIComponent(here)}`);
    }
    return response;
  },
};

export const api = createClient<paths>({ baseUrl: "" });
api.use(csrfHeaders, signInWhenSignedOut);

/** One rejected input from a 422, located by its path in the request body ("arms.0.concentration";
 * "" when the rule spans several fields). */
export type FieldIssue = { path: string; message: string };

export class ApiError extends Error {
  readonly status: number;
  readonly issues: readonly FieldIssue[];

  constructor(status: number, message: string, issues: readonly FieldIssue[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.issues = issues;
  }
}

const VALIDATION_WORDING: Record<string, string> = {
  "Field required": "Required.",
  "String should have at least 1 character": "Required.",
};

const BOUND_WORDING: [RegExp, (bound: string) => string][] = [
  [/^Input should be less than or equal to (\S+)$/, (bound) => `Must be ${bound} or less.`],
  [/^Input should be greater than or equal to (\S+)$/, (bound) => `Must be ${bound} or more.`],
  [/^Input should be less than (\S+)$/, (bound) => `Must be less than ${bound}.`],
  [/^Input should be greater than (\S+)$/, (bound) => `Must be more than ${bound}.`],
];

/** Pydantic's wording ("Value error, the amount…", "Input should be…") as a sentence the lab reads. */
function readableValidation(raw: string): string {
  const known = VALIDATION_WORDING[raw];
  if (known) return known;
  for (const [pattern, wording] of BOUND_WORDING) {
    const bound = pattern.exec(raw)?.[1];
    if (bound !== undefined) return wording(bound);
  }
  const text = raw.replace(/^Value error, /, "");
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

function validationIssue(item: unknown): FieldIssue | null {
  if (typeof item !== "object" || item === null || !("msg" in item) || typeof item.msg !== "string") return null;
  const loc: unknown[] = "loc" in item && Array.isArray(item.loc) ? item.loc : [];
  const path = loc
    .filter((part) => part !== "body")
    .map(String)
    .join(".");
  return { path, message: readableValidation(item.msg) };
}

/** FastAPI answers `{detail: string}` for HTTP errors and `{detail: ValidationError[]}` for 422s;
 * a proxy in front of it may answer plain text. */
function detailOf(body: unknown, status: number): { message: string; issues: FieldIssue[] } {
  if (typeof body === "object" && body !== null && "detail" in body) {
    const { detail } = body;
    if (typeof detail === "string") return { message: detail, issues: [] };
    if (Array.isArray(detail)) {
      const issues = detail.map(validationIssue).filter((issue) => issue !== null);
      if (issues.length > 0) {
        const message = issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join(" ");
        return { message, issues };
      }
    }
  }
  if (status >= 500) return { message: `The Wet Lab API is unavailable (HTTP ${status}). Check that it is running.`, issues: [] };
  return { message: `The request failed (HTTP ${status}).`, issues: [] };
}

/** openapi-fetch resolves to `{data}` on success and `{error}` otherwise; every endpoint here returns a body. */
export async function unwrap<T>(pending: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await pending;
  if (error !== undefined || data === undefined) {
    const { message, issues } = detailOf(error, response.status);
    throw new ApiError(response.status, message, issues);
  }
  return data;
}

type WireFit = Omit<Schemas["FitOut"], "window_min" | "fit_line"> & { window_min: number[] | null; fit_line: number[][] };
type WireDepletion = Omit<Schemas["DepletionResult"], "arms"> & {
  arms: (Omit<Schemas["ArmResult"], "fit"> & { fit: WireFit })[];
};

function pair(values: readonly number[]): [number, number] | null {
  const [first, second] = values;
  return values.length === 2 && first !== undefined && second !== undefined ? [first, second] : null;
}

/** openapi-fetch's response types widen the schema's `[number, number]` tuples to `number[]`, so the
 * fit line and window are re-read as pairs here, once, where the data enters. */
export function parseDepletion(wire: WireDepletion): Schemas["DepletionResult"] {
  return {
    ...wire,
    arms: wire.arms.map((arm) => ({
      ...arm,
      fit: {
        ...arm.fit,
        window_min: arm.fit.window_min ? pair(arm.fit.window_min) : null,
        fit_line: arm.fit.fit_line.map(pair).filter((point) => point !== null),
      },
    })),
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return "Can't reach the Wet Lab API. Check your connection and that the API is running.";
  return error instanceof Error ? error.message : "Something went wrong.";
}
