"use client";
import { useState } from "react";
import { Copy, MailPlus, Trash2, UserRoundCog } from "lucide-react";
import type { HubData, Mutate, TeamMember } from "./types";

const roles = [
  "ADMIN",
  "SOCIAL_MANAGER",
  "CONTENT_CREATOR",
  "CLIENT_REVIEWER",
  "VIEWER",
] as const;
const roleName = (role: string) => role.toLowerCase().replaceAll("_", " ");

function ClientChoices({
  data,
  selected,
  setSelected,
  disabled,
}: {
  data: HubData;
  selected: string[];
  setSelected: (ids: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="client-choices" disabled={disabled}>
      <legend>Client access</legend>
      {data.clients.map((client) => (
        <label key={client.id}>
          <input
            type="checkbox"
            checked={selected.includes(client.id)}
            onChange={(event) =>
              setSelected(
                event.target.checked
                  ? [...selected, client.id]
                  : selected.filter((id) => id !== client.id),
              )
            }
          />
          {client.name}
        </label>
      ))}
    </fieldset>
  );
}

function MemberEditor({
  member,
  data,
  mutate,
  busy,
}: {
  member: TeamMember;
  data: HubData;
  mutate: Mutate;
  busy: boolean;
}) {
  const [role, setRole] = useState(member.role);
  const [clientIds, setClientIds] = useState(member.clients.map((c) => c.id));
  const [editing, setEditing] = useState(false);
  const protectedMember =
    member.role === "OWNER" ||
    member.id === data.user.id ||
    (member.role === "ADMIN" && data.role !== "OWNER");
  return (
    <article className="team-member">
      <div className="member-identity">
        <span className="avatar">{member.name.slice(0, 2).toUpperCase()}</span>
        <span>
          <strong>{member.name}</strong>
          <small>{member.email}</small>
        </span>
      </div>
      <div className="member-access">
        <strong>{roleName(member.role)}</strong>
        <small>
          {["OWNER", "ADMIN"].includes(member.role)
            ? "All clients"
            : member.clients.map((client) => client.name).join(", ")}
        </small>
      </div>
      {!protectedMember && (
        <button onClick={() => setEditing(!editing)}>
          {editing ? "Close" : "Manage access"}
        </button>
      )}
      {!protectedMember && editing && (
        <div className="member-editor">
          <label className="member-role">
            Role
            <select
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              {roles
                .filter((item) => item !== "ADMIN" || data.role === "OWNER")
                .map((item) => (
                  <option key={item} value={item}>
                    {roleName(item)}
                  </option>
                ))}
            </select>
          </label>
          {role !== "ADMIN" && (
            <ClientChoices
              data={data}
              selected={clientIds}
              setSelected={setClientIds}
            />
          )}
          <div className="member-actions">
            <button
              disabled={busy || (role !== "ADMIN" && !clientIds.length)}
              onClick={() =>
                mutate("team.member.update", {
                  userId: member.id,
                  role,
                  clientIds,
                })
                  .then(() => setEditing(false))
                  .catch(() => {})
              }
            >
              Save access
            </button>
            <button
              className="danger-button"
              disabled={busy}
              aria-label={`Remove ${member.name}`}
              onClick={() => {
                if (
                  window.confirm(`Remove ${member.name} from this workspace?`)
                )
                  mutate("team.member.remove", { userId: member.id }).catch(
                    () => {},
                  );
              }}
            >
              <Trash2 size={15} /> Remove
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

export function Team({
  data,
  mutate,
  busy,
}: {
  data: HubData;
  mutate: Mutate;
  busy: boolean;
}) {
  const [role, setRole] = useState("CONTENT_CREATOR");
  const [clientIds, setClientIds] = useState<string[]>(
    data.clientId ? [data.clientId] : [],
  );
  const [inviteUrl, setInviteUrl] = useState("");
  return (
    <>
      <section className="panel">
        <div className="panel-title">
          <div>
            <h2>Invite a team member</h2>
            <span className="muted">
              Access starts only after the invitation is accepted.
            </span>
          </div>
          <MailPlus size={20} />
        </div>
        <form
          className="team-invite"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            setInviteUrl("");
            mutate("team.invite", {
              email: new FormData(form).get("email"),
              role,
              clientIds,
            })
              .then((result) => {
                form.reset();
                setInviteUrl(result.url ?? "");
              })
              .catch(() => {});
          }}
        >
          <label>
            Email address
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Role
            <select
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              {roles
                .filter((item) => item !== "ADMIN" || data.role === "OWNER")
                .map((item) => (
                  <option key={item} value={item}>
                    {roleName(item)}
                  </option>
                ))}
            </select>
          </label>
          {role !== "ADMIN" && (
            <ClientChoices
              data={data}
              selected={clientIds}
              setSelected={setClientIds}
            />
          )}
          <button
            className="primary"
            disabled={busy || (role !== "ADMIN" && !clientIds.length)}
          >
            Send invitation
          </button>
        </form>
        {inviteUrl && (
          <div className="notice invitation-link" role="status">
            <span>
              Development invitation link: <a href={inviteUrl}>{inviteUrl}</a>
            </span>
            <button
              aria-label="Copy invitation link"
              onClick={() => navigator.clipboard.writeText(inviteUrl)}
            >
              <Copy size={15} /> Copy
            </button>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-title">
          <h2>Workspace team</h2>
          <span className="muted">{data.team.length} members</span>
        </div>
        <div className="team-list">
          {data.team.map((member) => (
            <MemberEditor
              key={member.id}
              member={member}
              data={data}
              mutate={mutate}
              busy={busy}
            />
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="panel-title">
          <h2>Pending invitations</h2>
          <span className="muted">Expire after seven days</span>
        </div>
        {data.invitations.map((invitation) => (
          <div className="pending-invite" key={invitation.id}>
            <UserRoundCog size={18} />
            <span>
              <strong>{invitation.email}</strong>
              <small>
                {roleName(invitation.role)} ·{" "}
                {invitation.clients.length
                  ? invitation.clients.map((client) => client.name).join(", ")
                  : "all clients"}
              </small>
            </span>
            <small>
              Expires{" "}
              {new Intl.DateTimeFormat("en-GB", {
                timeZone: data.user.timezone,
                dateStyle: "medium",
              }).format(new Date(invitation.expires_at))}
            </small>
            <button
              disabled={
                busy || (invitation.role === "ADMIN" && data.role !== "OWNER")
              }
              onClick={() =>
                mutate("team.invitation.revoke", {
                  invitationId: invitation.id,
                }).catch(() => {})
              }
            >
              Revoke
            </button>
          </div>
        ))}
        {!data.invitations.length && (
          <div className="empty compact">No pending invitations.</div>
        )}
      </section>
    </>
  );
}
