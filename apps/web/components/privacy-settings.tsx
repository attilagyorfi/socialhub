"use client";
import { useState } from "react";
import { Download, ShieldCheck, Trash2 } from "lucide-react";
import { useT, type MessageKey } from "../i18n";
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
  const { t } = useT();
  const [retentionDays, setRetentionDays] = useState(
    data.privacy.organization?.retentionDays ?? 365,
  );
  const [userConfirmation, setUserConfirmation] = useState("");
  const [organizationConfirmation, setOrganizationConfirmation] = useState("");
  const userRequest = data.privacy.userRequest;
  const organization = data.privacy.organization;
  const organizationRequest = organization?.request;
  const statusLabel = (status: string) =>
    t(`settings.privacy.status.${status}` as MessageKey);

  return (
    <section className="panel privacy-settings">
      <div className="panel-title">
        <div>
          <h2>{t("settings.privacy.title")}</h2>
          <span className="muted">{t("settings.privacy.subtitle")}</span>
        </div>
        <ShieldCheck size={20} />
      </div>
      <div className="privacy-grid">
        <article>
          <h3>{t("settings.privacy.export.title")}</h3>
          <p className="muted">{t("settings.privacy.export.body")}</p>
          <a className="button-link" href="/api/privacy/export" download>
            <Download size={15} /> {t("settings.privacy.export.download")}
          </a>
        </article>

        {organization && (
          <article>
            <h3>{t("settings.privacy.retention.title")}</h3>
            <p className="muted">{t("settings.privacy.retention.body")}</p>
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
                {t("settings.privacy.retention.days")}
                <input
                  aria-label={t("settings.privacy.retention.days")}
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
                {t("settings.privacy.retention.save")}
              </button>
            </form>
          </article>
        )}
      </div>

      <div className="privacy-danger-zone">
        <h3>{t("settings.privacy.deletion.title")}</h3>
        {userRequest ? (
          <div className="notice warning privacy-request">
            <span>
              <strong>
                {t("settings.privacy.deletion.account", {
                  status: statusLabel(userRequest.status),
                })}
              </strong>
              <small>
                {t("settings.privacy.deletion.scheduledFor", {
                  date: formatDate(
                    userRequest.executeAfter,
                    data.user.timezone,
                  ),
                })}
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
              {t("settings.privacy.deletion.cancel")}
            </button>
          </div>
        ) : (
          <details>
            <summary>{t("settings.privacy.deletion.deleteAccount")}</summary>
            <p className="muted">
              {t("settings.privacy.deletion.accountBody")}
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
                {t("settings.privacy.deletion.confirmEmail")}
                <input
                  aria-label={t("settings.privacy.deletion.confirmEmail")}
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
                <Trash2 size={15} />{" "}
                {t("settings.privacy.deletion.requestAccount")}
              </button>
            </form>
          </details>
        )}

        {organization?.canDelete &&
          (organizationRequest ? (
            <div className="notice warning privacy-request">
              <span>
                <strong>
                  {t("settings.privacy.deletion.organization", {
                    status: statusLabel(organizationRequest.status),
                  })}
                </strong>
                <small>
                  {t("settings.privacy.deletion.scheduledFor", {
                    date: formatDate(
                      organizationRequest.executeAfter,
                      data.user.timezone,
                    ),
                  })}
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
                {t("settings.privacy.deletion.cancel")}
              </button>
            </div>
          ) : (
            <details>
              <summary>
                {t("settings.privacy.deletion.deleteOrganization", {
                  name: organization.name,
                })}
              </summary>
              <p className="muted">
                {t("settings.privacy.deletion.organizationBody")}
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
                  {t("settings.privacy.deletion.confirmOrganization")}
                  <input
                    aria-label={t(
                      "settings.privacy.deletion.confirmOrganization",
                    )}
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
                  <Trash2 size={15} />{" "}
                  {t("settings.privacy.deletion.requestOrganization")}
                </button>
              </form>
            </details>
          ))}
      </div>
    </section>
  );
}
