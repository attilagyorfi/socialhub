"use client";
import { useState } from "react";
import { Download, ShieldCheck, Trash2 } from "lucide-react";
import { formatDate, type HubData, type Mutate } from "./types";

export function PrivacySettings({
  data,
  mutate,
  busy,
}: {
  data: HubData;
  mutate: Mutate;
  busy: boolean;
}) {
  const [retentionDays, setRetentionDays] = useState(
    data.privacy.organization?.retentionDays ?? 365,
  );
  const [userConfirmation, setUserConfirmation] = useState("");
  const [organizationConfirmation, setOrganizationConfirmation] = useState("");
  const userRequest = data.privacy.userRequest;
  const organization = data.privacy.organization;
  const organizationRequest = organization?.request;

  return (
    <section className="panel privacy-settings">
      <div className="panel-title">
        <div>
          <h2>Privacy and data retention</h2>
          <span className="muted">
            Export personal data or manage verified deletion requests.
          </span>
        </div>
        <ShieldCheck size={20} />
      </div>
      <div className="privacy-grid">
        <article>
          <h3>Personal data export</h3>
          <p className="muted">
            Download your profile, memberships, authored content, approval
            activity and audit events as JSON. Passwords, sessions and provider
            credentials are excluded.
          </p>
          <a className="button-link" href="/api/privacy/export" download>
            <Download size={15} /> Download my data
          </a>
        </article>

        {organization && (
          <article>
            <h3>Organization retention</h3>
            <p className="muted">
              Completed operational records older than this period are removed
              by the worker. Active posts and media remain available.
            </p>
            <form
              className="inline-form compact-form"
              onSubmit={(event) => {
                event.preventDefault();
                mutate("privacy.retention.update", { retentionDays }).catch(
                  () => {},
                );
              }}
            >
              <label>
                Retention days
                <input
                  aria-label="Retention days"
                  type="number"
                  min={30}
                  max={3650}
                  disabled={!organization.canManageRetention}
                  value={retentionDays}
                  onChange={(event) =>
                    setRetentionDays(Number(event.target.value))
                  }
                />
              </label>
              <button
                disabled={
                  busy ||
                  !organization.canManageRetention ||
                  retentionDays === organization.retentionDays
                }
              >
                Save retention
              </button>
            </form>
          </article>
        )}
      </div>

      <div className="privacy-danger-zone">
        <h3>Deletion requests</h3>
        {userRequest ? (
          <div className="notice warning privacy-request">
            <span>
              <strong>
                Account deletion: {userRequest.status.toLowerCase()}
              </strong>
              <small>
                Scheduled for{" "}
                {formatDate(userRequest.executeAfter, data.user.timezone)}
                {userRequest.errorCode ? ` · ${userRequest.errorCode}` : ""}
              </small>
            </span>
            <button
              disabled={busy || userRequest.status === "RUNNING"}
              onClick={() =>
                mutate("privacy.request.cancel", {
                  requestId: userRequest.id,
                }).catch(() => {})
              }
            >
              Cancel request
            </button>
          </div>
        ) : (
          <details>
            <summary>Delete my account</summary>
            <p className="muted">
              Deletion starts after 24 hours and can be cancelled before
              processing. You must transfer ownership of organizations where you
              are the sole owner.
            </p>
            <form
              className="inline-form compact-form"
              onSubmit={(event) => {
                event.preventDefault();
                mutate("privacy.user.erase.request", {
                  confirmation: userConfirmation,
                })
                  .then(() => setUserConfirmation(""))
                  .catch(() => {});
              }}
            >
              <label>
                Confirm your email address
                <input
                  aria-label="Confirm your email address"
                  type="email"
                  autoComplete="off"
                  value={userConfirmation}
                  onChange={(event) => setUserConfirmation(event.target.value)}
                />
              </label>
              <button
                className="danger-button"
                disabled={busy || userConfirmation !== data.user.email}
              >
                <Trash2 size={15} /> Request account deletion
              </button>
            </form>
          </details>
        )}

        {organization?.canDelete &&
          (organizationRequest ? (
            <div className="notice warning privacy-request">
              <span>
                <strong>
                  Organization deletion:{" "}
                  {organizationRequest.status.toLowerCase()}
                </strong>
                <small>
                  Scheduled for{" "}
                  {formatDate(
                    organizationRequest.executeAfter,
                    data.user.timezone,
                  )}
                  {organizationRequest.errorCode
                    ? ` · ${organizationRequest.errorCode}`
                    : ""}
                </small>
              </span>
              <button
                disabled={busy || organizationRequest.status === "RUNNING"}
                onClick={() =>
                  mutate("privacy.request.cancel", {
                    requestId: organizationRequest.id,
                  }).catch(() => {})
                }
              >
                Cancel request
              </button>
            </div>
          ) : (
            <details>
              <summary>Delete {organization.name}</summary>
              <p className="muted">
                This permanently removes all clients, content, analytics and
                stored media after 72 hours. Live provider grants must be
                disconnected and revoked first.
              </p>
              <form
                className="inline-form compact-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  mutate("privacy.organization.erase.request", {
                    confirmation: organizationConfirmation,
                  })
                    .then(() => setOrganizationConfirmation(""))
                    .catch(() => {});
                }}
              >
                <label>
                  Type the organization name
                  <input
                    aria-label="Type the organization name"
                    autoComplete="off"
                    value={organizationConfirmation}
                    onChange={(event) =>
                      setOrganizationConfirmation(event.target.value)
                    }
                  />
                </label>
                <button
                  className="danger-button"
                  disabled={
                    busy || organizationConfirmation !== organization.name
                  }
                >
                  <Trash2 size={15} /> Request organization deletion
                </button>
              </form>
            </details>
          ))}
      </div>
    </section>
  );
}
