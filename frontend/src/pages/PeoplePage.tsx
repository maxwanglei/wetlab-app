import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { errorMessage, type Schemas } from "@/api/client";
import { mutations, queries } from "@/api/queries";
import { Input, ProblemAlert } from "@/components/form";
import { EmptyState, ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Member = Schemas["MemberOut"];

function TextField({
  id,
  label,
  value,
  onChange,
  type = "text",
  required = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "password";
  required?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-sm font-bold text-ink-2">
        {label}
      </label>
      <Input
        id={id}
        type={type}
        required={required}
        autoComplete={type === "password" ? "new-password" : "off"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function Checkbox({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm font-bold text-ink-2">
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4" />
      {label}
    </label>
  );
}

function AddPerson() {
  const queryClient = useQueryClient();
  const alertRef = useRef<HTMLDivElement>(null);
  const blank = { full_name: "", email: "", role: "", password: "", is_admin: false };
  const [draft, setDraft] = useState(blank);
  const add = useMutation({
    mutationFn: mutations.addMember,
    onSuccess: async () => {
      setDraft(blank);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["members"] }),
        queryClient.invalidateQueries({ queryKey: ["reference"] }),
      ]);
    },
    onError: () => requestAnimationFrame(() => alertRef.current?.focus()),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    add.mutate({ ...draft, role: draft.role.trim() || null });
  }
  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-rule bg-surface p-5">
      <h2 className="text-lg font-bold">Add a person</h2>
      <p className="text-sm text-ink-2">
        Give them their email and this first password. They can change it on their account page after signing in.
      </p>
      <ProblemAlert title="Not added" message={add.isError ? errorMessage(add.error) : null} alertRef={alertRef} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField id="add-name" label="Name" required value={draft.full_name} onChange={(full_name) => setDraft({ ...draft, full_name })} />
        <TextField id="add-email" label="Email" type="email" required value={draft.email} onChange={(email) => setDraft({ ...draft, email })} />
        <TextField id="add-role" label="Role" value={draft.role} onChange={(role) => setDraft({ ...draft, role })} />
        <TextField
          id="add-password"
          label="First password (10 or more characters)"
          type="password"
          required
          value={draft.password}
          onChange={(password) => setDraft({ ...draft, password })}
        />
      </div>
      <div className="flex flex-wrap items-center gap-6">
        <Checkbox id="add-admin" label="Admin: can add people and reset passwords" checked={draft.is_admin} onChange={(is_admin) => setDraft({ ...draft, is_admin })} />
        <Button type="submit" className="font-bold" disabled={add.isPending}>
          Add person
        </Button>
      </div>
    </form>
  );
}

function EditPerson({ member, onDone }: { member: Member; onDone: () => void }) {
  const queryClient = useQueryClient();
  const alertRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState({
    full_name: member.full_name,
    role: member.role ?? "",
    is_admin: member.is_admin,
    is_active: member.is_active,
  });
  const [password, setPassword] = useState("");
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["members"] }),
      queryClient.invalidateQueries({ queryKey: ["reference"] }),
      queryClient.invalidateQueries({ queryKey: ["me"] }),
    ]);
  const focusAlert = () => requestAnimationFrame(() => alertRef.current?.focus());
  const save = useMutation({
    mutationFn: () => mutations.updateMember(member.id, { ...draft, role: draft.role.trim() || null }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
    onError: focusAlert,
  });
  const reset = useMutation({
    mutationFn: () => mutations.setMemberPassword(member.id, { new_password: password }),
    onSuccess: async () => {
      setPassword("");
      await refresh();
    },
    onError: focusAlert,
  });
  const failed = save.isError ? save.error : reset.isError ? reset.error : null;
  return (
    <section aria-label={`Change ${member.full_name}`} className="space-y-4 rounded-lg border border-rule-strong bg-surface p-5">
      <h2 className="text-lg font-bold">Change {member.full_name}</h2>
      <ProblemAlert title="Not changed" message={failed ? errorMessage(failed) : null} alertRef={alertRef} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField id="edit-name" label="Name" required value={draft.full_name} onChange={(full_name) => setDraft({ ...draft, full_name })} />
          <TextField id="edit-role" label="Role" value={draft.role} onChange={(role) => setDraft({ ...draft, role })} />
        </div>
        <div className="flex flex-wrap gap-6">
          <Checkbox id="edit-admin" label="Admin" checked={draft.is_admin} onChange={(is_admin) => setDraft({ ...draft, is_admin })} />
          <Checkbox
            id="edit-active"
            label="Active: can sign in and be named on experiments"
            checked={draft.is_active}
            onChange={(is_active) => setDraft({ ...draft, is_active })}
          />
        </div>
        <div className="flex gap-3">
          <Button type="submit" className="font-bold" disabled={save.isPending}>
            Save
          </Button>
          <Button type="button" variant="outline" onClick={onDone}>
            Close
          </Button>
        </div>
      </form>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          reset.mutate();
        }}
        className="flex flex-wrap items-end gap-3 border-t border-rule pt-4"
      >
        <TextField id="edit-password" label="New password (signs them out everywhere)" type="password" required value={password} onChange={setPassword} />
        <Button type="submit" variant="outline" className="font-bold" disabled={reset.isPending}>
          Set password
        </Button>
        {reset.isSuccess ? (
          <p role="status" className="text-sm font-bold text-good-fg">
            Password set.
          </p>
        ) : null}
      </form>
    </section>
  );
}

export function PeoplePage() {
  const me = useQuery(queries.me());
  const members = useQuery({ ...queries.members(), enabled: me.data?.is_admin === true });
  const [editing, setEditing] = useState<number | null>(null);

  if (me.isPending) return <Loading label="Loading…" />;
  if (me.isError) return <ErrorState title="Your account could not load" error={me.error} onRetry={() => me.refetch()} />;
  if (!me.data.is_admin) return <EmptyState title="Only admins manage people">Ask an admin in your lab to add or change someone.</EmptyState>;

  const chosen = members.data?.find((member) => member.id === editing);
  return (
    <div className="space-y-6">
      <h1 className="text-[1.75rem] leading-tight font-bold">People</h1>
      {members.isPending ? (
        <Loading label="Loading people…" />
      ) : members.isError ? (
        <ErrorState title="People could not load" error={members.error} onRetry={() => members.refetch()} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-rule bg-surface">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>
                  <span className="sr-only">Change</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.data.map((member) => (
                <TableRow key={member.id}>
                  <TableCell className="font-bold">{member.full_name}</TableCell>
                  <TableCell>{member.email ?? "—"}</TableCell>
                  <TableCell>{member.role ?? "—"}</TableCell>
                  <TableCell>
                    {!member.is_active ? "Turned off" : !member.can_sign_in ? "No password yet" : member.is_admin ? "Admin" : "Can sign in"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => setEditing(member.id)} aria-label={`Change ${member.full_name}`}>
                      Change
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {chosen ? <EditPerson key={chosen.id} member={chosen} onDone={() => setEditing(null)} /> : null}
      <AddPerson />
    </div>
  );
}
