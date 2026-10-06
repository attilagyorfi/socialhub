"use client";
import { useState } from "react";
import { Copy, MailPlus, Trash2, UserRoundCog } from "lucide-react";
import type { HubData, Mutate, TeamMember } from "./types";
import { intlLocale, useT, type MessageKey } from "../i18n";

const roles = [
  "ADMIN",
  "SOCIAL_MANAGER",
  "CONTENT_CREATOR",
  "CLIENT_REVIEWER",
  "VIEWER",
] as const;
const roleKey = (role: string) => `common.role.${role}` as MessageKey;

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
  const { t } = useT();
  return (
    <fieldset className="client-choices" disabled={disabled}>
      <legend>{t("team.clientAccess")}</legend>
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
  const { t } = useT();
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
        <strong>{t(roleKey(member.role))}</strong>
        <small>
          {["OWNER", "ADMIN"].includes(member.role)
            ? t("team.allClients")
            : member.clients.map((client) => client.name).join(", ")}
        </small>
      </div>
      {!protectedMember && (
        <button onClick={() => setEditing(!editing)}>
          {editing ? t("team.close") : t("team.manageAccess")}
        </button>
      )}
      {!protectedMember && editing && (
        <div className="member-editor">
          <label className="member-role">
            {t("team.role")}
            <select
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              {roles
                .filter((item) => item !== "ADMIN" || data.role === "OWNER")
                .map((item) => (
                  <option key={item} value={item}>
                    {t(roleKey(item))}
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
              {t("team.saveAccess")}
            </button>
            <button
              className="danger-button"
              disabled={busy}
              aria-label={t("team.removeLabel", { name: member.name })}
              onClick={() => {
                if (
                  window.confirm(t("team.removeConfirm", { name: member.name }))
                )
                  mutate("team.member.remove", { userId: member.id }).catch(
                    () => {},
                  );
              }}
            >
              <Trash2 size={15} /> {t("team.remove")}
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
  const { t } = useT();
  return (
    <>
      <section className="panel">
        <div className="panel-title">
          <div>
            <h2>{t("team.inviteTitle")}</h2>
            <span className="muted">{t("team.inviteNote")}</span>
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
            {t("team.email")}
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            {t("team.role")}
            <select
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              {roles
                .filter((item) => item !== "ADMIN" || data.role === "OWNER")
                .map((item) => (
                  <option key={item} value={item}>
                    {t(roleKey(item))}
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
            {t("team.sendInvitation")}
          </button>
        </form>
        {inviteUrl && (
          <div className="notice invitation-link" role="status">
            <span>
              {t("team.devLink")} <a href={inviteUrl}>{inviteUrl}</a>
            </span>
            <button
              aria-label={t("team.copyLink")}
              onClick={() => navigator.clipboard.writeText(inviteUrl)}
            >
              <Copy size={15} /> {t("team.copy")}
            </button>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-title">
          <h2>{t("team.workspaceTeam")}</h2>
          <span className="muted">
            {t(data.team.length === 1 ? "team.members.one" : "team.members", {
              count: data.team.length,
            })}
          </span>
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
          <h2>{t("team.pendingTitle")}</h2>
          <span className="muted">{t("team.pendingNote")}</span>
        </div>
        {data.invitations.map((invitation) => (
          <div className="pending-invite" key={invitation.id}>
            <UserRoundCog size={18} />
            <span>
              <strong>{invitation.email}</strong>
              <small>
                {t(roleKey(invitation.role))} ·{" "}
                {invitation.clients.length
                  ? invitation.clients.map((client) => client.name).join(", ")
                  : t("team.allClientsLower")}
              </small>
            </span>
            <small>
              {t("team.expires", {
                date: new Intl.DateTimeFormat(intlLocale(), {
                  timeZone: data.user.timezone,
                  dateStyle: "medium",
                }).format(new Date(invitation.expires_at)),
              })}
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
              {t("team.revoke")}
            </button>
          </div>
        ))}
        {!data.invitations.length && (
          <div className="empty compact">{t("team.noPending")}</div>
        )}
      </section>
    </>
  );
}
