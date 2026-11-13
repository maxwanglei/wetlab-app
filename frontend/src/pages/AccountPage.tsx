import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { errorMessage } from "@/api/client";
import { mutations, queries } from "@/api/queries";
import { Input, ProblemAlert } from "@/components/form";
import { ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";

export function AccountPage() {
  const me = useQuery(queries.me());
  const queryClient = useQueryClient();
  const alertRef = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const change = useMutation({
    mutationFn: mutations.changePassword,
    onSuccess: (user) => {
      queryClient.setQueryData(queries.me().queryKey, user);
      setCurrent("");
      setNext("");
      setAgain("");
    },
    onError: () => requestAnimationFrame(() => alertRef.current?.focus()),
  });

  if (me.isPending) return <Loading label="Loading your account…" />;
  if (me.isError) return <ErrorState title="Your account could not load" error={me.error} onRetry={() => me.refetch()} />;

  function submit(event: FormEvent) {
    event.preventDefault();
    setMismatch(next !== again);
    if (next !== again) return;
    change.mutate({ current_password: current, new_password: next });
  }

  const problem = mismatch ? "The two new passwords differ." : change.isError ? errorMessage(change.error) : null;
  return (
    <div className="max-w-md space-y-6">
      <div>
        <h1 className="text-[1.75rem] leading-tight font-bold">{me.data.full_name}</h1>
        <p className="text-ink-2">{me.data.email}</p>
      </div>
      <form onSubmit={submit} className="space-y-4 rounded-lg border border-rule bg-surface p-5">
        <h2 className="text-lg font-bold">Change your password</h2>
        <p className="text-sm text-ink-2">At least 10 characters. Changing it signs you out on your other devices.</p>
        <ProblemAlert title="Password not changed" message={problem} alertRef={alertRef} />
        {change.isSuccess && !problem ? (
          <p role="status" className="flex items-center gap-2 text-sm font-bold text-good-fg">
            <CircleCheck aria-hidden className="size-4" />
            Password changed.
          </p>
        ) : null}
        {(
          [
            ["account-current", "Current password", current, setCurrent, "current-password"],
            ["account-new", "New password", next, setNext, "new-password"],
            ["account-again", "New password again", again, setAgain, "new-password"],
          ] as const
        ).map(([id, label, value, set, autoComplete]) => (
          <div key={id} className="flex flex-col gap-1">
            <label htmlFor={id} className="text-sm font-bold text-ink-2">
              {label}
            </label>
            <Input
              id={id}
              type="password"
              required
              autoComplete={autoComplete}
              value={value}
              onChange={(event) => set(event.target.value)}
            />
          </div>
        ))}
        <Button type="submit" className="font-bold" disabled={change.isPending}>
          Change password
        </Button>
      </form>
    </div>
  );
}
