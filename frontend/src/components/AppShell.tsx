import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, NavLink, Outlet, ScrollRestoration, isRouteErrorResponse, useNavigate, useRouteError } from "react-router";
import { mutations, queries } from "@/api/queries";
import { errorMessage } from "@/api/client";
import { ErrorState } from "@/components/states";
import { cn } from "@/lib/utils";

/** Two filled wells: Carolina blue and Ohio State scarlet, one plate. */
const WELL_FILL: Readonly<Record<number, string>> = { 1: "var(--carolina)", 4: "var(--scarlet)" };

function WellPlateMark() {
  const wells = [
    [5, 5],
    [13, 5],
    [21, 5],
    [5, 13],
    [13, 13],
    [21, 13],
  ] as const;
  return (
    <svg aria-hidden width="26" height="18" viewBox="0 0 26 18" className="shrink-0">
      {wells.map(([cx, cy], index) => (
        <circle
          key={`${cx}-${cy}`}
          cx={cx}
          cy={cy}
          r="3.3"
          fill={WELL_FILL[index] ?? "none"}
          stroke={WELL_FILL[index] ?? "var(--ink)"}
          strokeWidth="1.4"
        />
      ))}
    </svg>
  );
}

function SignedInUser() {
  const me = useQuery(queries.me());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation({
    mutationFn: mutations.logout,
    onSuccess: () => {
      queryClient.clear();
      void navigate("/login");
    },
  });
  if (me.isPending) return <span className="text-sm text-ink-3">Signing in…</span>;
  if (me.isError) return <span className="text-sm text-critical-fg">Not signed in</span>;
  const user = me.data;
  return (
    <span className="flex items-center gap-3 text-sm">
      <span className="sr-only">Signed in as</span>
      <Link to="/account" title={user.email} className="rounded-sm font-bold text-ink underline-offset-2 hover:underline">
        <span className="sm:hidden">Account</span>
        <span className="hidden sm:inline">{user.full_name}</span>
      </Link>
      <button
        type="button"
        onClick={() => signOut.mutate()}
        disabled={signOut.isPending}
        className="rounded-sm font-bold text-ballpoint underline-offset-2 hover:underline"
      >
        Sign out
      </button>
      {signOut.isError ? <span role="alert" className="max-w-64 text-sm text-critical-fg">Sign out failed. {errorMessage(signOut.error)}</span> : null}
    </span>
  );
}

const NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/experiments", label: "Experiments", end: false },
  { to: "/inventory", label: "Inventory", end: false },
] as const;
const ADMIN_NAV = [{ to: "/people", label: "People", end: false }] as const;

export function AppShell() {
  // Only a demo database holds made-up data; a lab's own database must not be labelled fictitious.
  const health = useQuery(queries.health());
  const me = useQuery(queries.me());
  const nav = me.data?.is_admin ? [...NAV, ...ADMIN_NAV] : NAV;
  return (
    <div className="flex min-h-svh flex-col">
      {health.data?.demo ? (
        <div className="bg-tape text-ink">
          <p className="mx-auto max-w-[1360px] px-4 py-1 text-sm sm:px-6">
            <strong>Demo data.</strong> Every value is fictitious, and the demo database can be reset at any time.
          </p>
        </div>
      ) : null}
      <header className="border-b border-rule bg-surface">
        <div aria-hidden className="flex h-[3px]">
          <span className="flex-1 bg-scarlet" />
          <span className="flex-1 bg-carolina" />
        </div>
        <div className="mx-auto flex max-w-[1360px] flex-wrap items-center gap-x-8 px-4 sm:h-14 sm:flex-nowrap sm:px-6">
          <Link
            to="/"
            className="flex items-center gap-2.5 rounded-sm py-3 text-lg font-bold tracking-tight whitespace-nowrap text-ink sm:py-0"
          >
            <WellPlateMark />
            Wet Lab
          </Link>
          <nav
            aria-label="Main"
            className="order-last -mx-4 flex h-11 w-[calc(100%+2rem)] items-stretch gap-1 overflow-x-auto border-t border-rule px-2 sm:order-none sm:mx-0 sm:h-full sm:w-auto sm:border-0 sm:px-0"
          >
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "relative flex items-center rounded-sm px-3 text-[0.9375rem] font-bold whitespace-nowrap text-ink-2 hover:text-ink",
                    isActive && "text-ink after:absolute after:inset-x-3 after:bottom-0 after:h-[3px] after:bg-scarlet",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto">
            <SignedInUser />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1360px] flex-1 px-4 pt-6 pb-16 sm:px-6">
        <Outlet />
      </main>
      <footer className="border-t border-rule bg-surface">
        <p className="mx-auto max-w-[1360px] px-4 py-4 text-sm text-ink-3 sm:px-6">
          Wet Lab, a research collaboration between The Ohio State University and the University of North Carolina at
          Chapel Hill.
        </p>
      </footer>
      <ScrollRestoration />
    </div>
  );
}

export function RouteError() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  return <ErrorState title="This page hit an error" error={error} />;
}

export function NotFound({ what = "page" }: { what?: string }) {
  return (
    <div className="py-16">
      <h1 className="text-2xl font-bold">No such {what}</h1>
      <p className="mt-2 text-ink-2">
        The link may be out of date. Go back to the{" "}
        <Link to="/" className="font-bold text-ballpoint underline underline-offset-2">
          dashboard
        </Link>
        .
      </p>
    </div>
  );
}
