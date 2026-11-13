import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { errorMessage } from "@/api/client";
import { mutations } from "@/api/queries";
import { Input, ProblemAlert } from "@/components/form";
import { Button } from "@/components/ui/button";

/** Only a path on this site, never another site, so a crafted link can't bounce someone away after signing in. */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") ? next : "/";
}

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const alertRef = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const signIn = useMutation({
    mutationFn: mutations.login,
    onSuccess: () => {
      queryClient.clear();
      void navigate(safeNext(params.get("next")), { replace: true });
    },
    onError: () => {
      setPassword("");
      requestAnimationFrame(() => alertRef.current?.focus());
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    signIn.mutate({ email, password });
  }

  return (
    <main className="flex min-h-svh items-start justify-center bg-paper px-4 pt-[12vh]">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-lg border border-rule bg-surface p-6 shadow-xs">
        <div>
          <h1 className="text-2xl font-bold">Wet Lab</h1>
          <p className="mt-1 text-sm text-ink-2">Sign in with the email and password your lab admin gave you.</p>
        </div>
        <ProblemAlert title="Not signed in" message={signIn.isError ? errorMessage(signIn.error) : null} alertRef={alertRef} />
        <div className="flex flex-col gap-1">
          <label htmlFor="login-email" className="text-sm font-bold text-ink-2">
            Email
          </label>
          <Input
            id="login-email"
            type="email"
            autoComplete="username"
            required
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="login-password" className="text-sm font-bold text-ink-2">
            Password
          </label>
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <Button type="submit" className="w-full font-bold" disabled={signIn.isPending}>
          {signIn.isPending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
