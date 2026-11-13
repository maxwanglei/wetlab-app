import { CircleAlert, Plus, X } from "lucide-react";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { useBeforeUnload, useBlocker, type Blocker } from "react-router";
import { ApiError, errorMessage } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { FieldErrors } from "@/lib/drafts";
import { cn } from "@/lib/utils";

/** DOM id of the input for a request-body path ("arms.0.concentration" → "field-arms-0-concentration"). */
export function fieldId(path: string): string {
  return `field-${path.replaceAll(".", "-")}`;
}

const ProblemsContext = createContext<{ errors: FieldErrors; clear: (path: string) => void }>({
  errors: {},
  clear: () => {},
});

/** Problems found in the form, by field, plus one message for anything no field on screen owns. After
 * each failed submit, focus moves to that message, or else to the first field with a problem. */
export function useFormProblems() {
  const formRef = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const [fields, setFields] = useState<FieldErrors>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (attempt === 0) return;
    if (alertRef.current) alertRef.current.focus();
    else formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [attempt]);

  const clear = useCallback((path: string) => {
    setFields((current) => {
      if (!(path in current)) return current;
      const { [path]: _cleared, ...rest } = current;
      return rest;
    });
  }, []);

  /** Drops the problems under a path prefix, for a list whose rows just moved. */
  const clearUnder = useCallback((prefix: string) => {
    setFields((current) => Object.fromEntries(Object.entries(current).filter(([path]) => !path.startsWith(`${prefix}.`))));
  }, []);

  return {
    formRef,
    alertRef,
    fields,
    general,
    clear,
    clearUnder,
    showFieldErrors(errors: FieldErrors) {
      setFields(errors);
      setGeneral(null);
      setAttempt((n) => n + 1);
    },
    /** 422 issues go to the field at their path when it is on screen; the rest, and any other error, to the top. */
    showServerError(error: unknown) {
      showAt(error, (path) => path);
    },
    /** As showServerError, with `formPath` turning an API path into the form's where the two lay a list out
     * differently. */
    showServerErrorAt(error: unknown, formPath: (path: string) => string) {
      showAt(error, formPath);
    },
  };

  function showAt(error: unknown, formPath: (path: string) => string) {
    const placed: Record<string, string> = {};
    const unplaced: string[] = [];
    if (error instanceof ApiError && error.issues.length > 0) {
      for (const issue of error.issues) {
        const path = issue.path ? formPath(issue.path) : issue.path;
        const onScreen = path && formRef.current?.querySelector(`#${CSS.escape(fieldId(path))}`);
        if (onScreen) placed[path] ??= issue.message;
        else unplaced.push(issue.message);
      }
    } else {
      unplaced.push(errorMessage(error));
    }
    setFields(placed);
    setGeneral(unplaced.length > 0 ? unplaced.join(" ") : null);
    setAttempt((n) => n + 1);
  }
}

export function FieldProblems({ errors, clear, children }: { errors: FieldErrors; clear: (path: string) => void; children: ReactNode }) {
  return <ProblemsContext value={{ errors, clear }}>{children}</ProblemsContext>;
}

type Control = {
  id: string;
  "aria-invalid": true | undefined;
  "aria-describedby": string | undefined;
  "aria-required": true | undefined;
  onInput: () => void;
};

/** A labelled input. `path` is where the value goes in the request body; it names the input and finds
 * the field's problem, which shows under it until the value is edited. */
export function Field({
  path,
  label,
  required = false,
  hint,
  className,
  children,
}: {
  path: string;
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  className?: string;
  children: (control: Control) => ReactNode;
}) {
  const { errors, clear } = use(ProblemsContext);
  const error = errors[path];
  const id = fieldId(path);
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={id} className="text-sm font-bold text-ink-2">
        {label}
        {required ? (
          <span aria-hidden className="ml-0.5 text-critical-fg">
            *
          </span>
        ) : null}
      </label>
      {children({
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy,
        "aria-required": required ? true : undefined,
        onInput: () => {
          if (error) clear(path);
        },
      })}
      {error ? (
        <p id={errorId} className="flex items-start gap-1 text-sm font-bold text-critical-fg">
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="text-sm text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL =
  "h-9 w-full min-w-0 rounded-md border border-input bg-surface px-2.5 text-[0.9375rem] text-ink shadow-xs transition-[color,box-shadow] outline-none placeholder:text-ink-3 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input autoComplete="off" {...props} className={cn(CONTROL, className)} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select {...props} className={cn(CONTROL, "pr-1.5", className)} />;
}

/** A number typed with its unit shown beside it; the unit is read out after the label. */
export function UnitInput({ unit, className, ...props }: ComponentProps<"input"> & { unit: ReactNode }) {
  const unitId = props.id ? `${props.id}-unit` : undefined;
  return (
    <div className="flex min-w-0">
      <Input
        inputMode="decimal"
        {...props}
        aria-describedby={[unitId, props["aria-describedby"]].filter(Boolean).join(" ") || undefined}
        className={cn("rounded-r-none tabular-nums", className)}
      />
      <span
        id={unitId}
        className="inline-flex h-9 shrink-0 items-center rounded-r-md border border-l-0 border-input bg-paper px-2.5 text-sm whitespace-nowrap text-ink-2"
      >
        {unit}
      </span>
    </div>
  );
}

/** A number with a choice of unit attached on its right. */
export function NumberWithUnit({
  unitValue,
  units,
  onUnitChange,
  unitLabel,
  ...props
}: ComponentProps<"input"> & {
  unitValue: string;
  units: readonly { value: string; label: string }[];
  onUnitChange: (value: string) => void;
  unitLabel: string;
}) {
  return (
    <div className="flex min-w-0">
      <Input inputMode="decimal" {...props} className="min-w-0 flex-1 rounded-r-none tabular-nums" />
      <Select
        aria-label={unitLabel}
        value={unitValue}
        onChange={(event) => onUnitChange(event.target.value)}
        className="w-auto shrink-0 rounded-l-none border-l-0 bg-paper text-sm"
      >
        {units.map((unit) => (
          <option key={unit.value} value={unit.value}>
            {unit.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

export function FormSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <Card role="region" aria-labelledby={headingId} className={className}>
      <CardHeader>
        <CardTitle>
          <h2 id={headingId}>{title}</h2>
        </CardTitle>
        {description ? <p className="max-w-[72ch] text-sm text-ink-3">{description}</p> : null}
      </CardHeader>
      <CardContent className="gap-4">{children}</CardContent>
    </Card>
  );
}

/** Focuses an element by id after the next render, such as the first field of a row about to appear. */
export function useFocusAfterRender(): (id: string) => void {
  const pending = useRef<string | null>(null);
  useEffect(() => {
    if (pending.current === null) return;
    document.getElementById(pending.current)?.focus();
    pending.current = null;
  });
  return useCallback((id: string) => {
    pending.current = id;
  }, []);
}

/** DOM id of the button that adds a row to the list at a request-body path ("arms" → "add-arms"). */
export function addRowId(path: string): string {
  return `add-${path.replaceAll(".", "-")}`;
}

export type ListEditor<Row> = {
  add: (row: Row) => void;
  remove: (index: number) => void;
  update: (index: number, patch: Partial<Row>) => void;
  /** Replaces a row with a function of itself, which is how a list inside a row is edited. */
  updateWith: (index: number, change: (row: Row) => Row) => void;
};

/** Edits one repeatable list held in form state, at a request-body path such as "arms" or
 * "arms.0.concentrations". Adding a row focuses its first field. Removing one clears the problems under the
 * list, because every later row's index shifts, and returns focus to the list's Add button. */
export function listEditor<Row>({
  path,
  rows,
  setRows,
  firstField,
  clearUnder,
  focusAfterRender,
}: {
  path: string;
  rows: readonly Row[];
  setRows: (update: (rows: readonly Row[]) => Row[]) => void;
  firstField: string;
  clearUnder: (prefix: string) => void;
  focusAfterRender: (id: string) => void;
}): ListEditor<Row> {
  const updateWith = (index: number, change: (row: Row) => Row) =>
    setRows((current) => current.map((row, at) => (at === index ? change(row) : row)));
  return {
    add(row) {
      setRows((current) => [...current, row]);
      focusAfterRender(fieldId(`${path}.${rows.length}.${firstField}`));
    },
    remove(index) {
      setRows((current) => current.filter((_, at) => at !== index));
      clearUnder(path);
      focusAfterRender(addRowId(path));
    },
    update: (index, patch) => updateWith(index, (row) => ({ ...row, ...patch })),
    updateWith,
  };
}

/** Adds a row to a repeatable list. Once the list is full it is disabled, with a note saying why. */
export function AddRowButton({
  path,
  full,
  fullNote = "That is the most one experiment can hold.",
  onClick,
  children,
}: {
  path: string;
  full: boolean;
  fullNote?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <Button id={addRowId(path)} type="button" variant="outline" onClick={onClick} disabled={full} className="px-3">
        <Plus aria-hidden />
        {children}
      </Button>
      {full ? <span className="text-sm text-ink-3">{fullNote}</span> : null}
    </div>
  );
}

/** One entry of a repeatable list (a cofactor, an arm, a pathway), with its own Remove button unless the
 * entry cannot be removed. */
export function RepeatGroup({
  title,
  removeLabel,
  onRemove,
  children,
}: {
  title: string;
  removeLabel: string;
  onRemove?: () => void;
  children: ReactNode;
}) {
  return (
    <fieldset className="rounded-md border border-rule bg-paper/60 px-4 pt-2.5 pb-4">
      <legend className="sr-only">{title}</legend>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span aria-hidden className="text-[0.9375rem] font-bold">
          {title}
        </span>
        {onRemove ? (
          <Button type="button" variant="ghost" size="sm" onClick={onRemove} aria-label={removeLabel} className="text-ink-2">
            <X aria-hidden />
            Remove
          </Button>
        ) : null}
      </div>
      {children}
    </fieldset>
  );
}

export function ProblemAlert({
  title,
  message,
  alertRef,
}: {
  title: string;
  message: string | null;
  alertRef: RefObject<HTMLDivElement | null>;
}) {
  if (!message) return null;
  return (
    <div
      ref={alertRef}
      tabIndex={-1}
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-critical-line bg-critical-bg px-4 py-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-critical-fg" />
      <div className="min-w-0 flex-1">
        <p className="font-bold text-critical-fg">{title}</p>
        <p className="text-sm text-ink">{message}</p>
      </div>
    </div>
  );
}

export function RequiredNote() {
  return (
    <p className="text-sm text-ink-3">
      Fields marked{" "}
      <span aria-hidden className="font-bold text-critical-fg">
        *
      </span>
      <span className="sr-only">with an asterisk</span> are required.
    </p>
  );
}

/** Holds navigation away from a form with unsaved input until the user confirms; a successful save
 * calls `allowLeave` first so its own navigation goes through. */
export function useLeaveGuard(dirty: boolean) {
  const leaving = useRef(false);
  useBeforeUnload(useCallback((event: BeforeUnloadEvent) => {
    if (dirty && !leaving.current) {
      event.preventDefault();
      event.returnValue = "";
    }
  }, [dirty]));
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname,
  );
  return {
    blocker,
    allowLeave() {
      leaving.current = true;
    },
  };
}

export function LeaveWarning({ blocker, what }: { blocker: Blocker; what: string }) {
  const stay = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (blocker.state === "blocked") stay.current?.focus();
  }, [blocker.state]);
  if (blocker.state !== "blocked") return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-warning-line bg-warning-bg px-4 py-3">
      <p className="flex-1 text-warning-fg">
        <strong>{what} is not saved.</strong> Leaving now discards what you have typed.
      </p>
      <Button ref={stay} type="button" variant="outline" onClick={() => blocker.reset()}>
        Keep editing
      </Button>
      <Button type="button" variant="destructive" onClick={() => blocker.proceed()}>
        Leave without saving
      </Button>
    </div>
  );
}
