"use client";
import { use, useEffect, useState } from "react";
export default function Approval({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [data, setData] = useState<any>();
  const [error, setError] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch(`/api/approval/${token}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        setData(d);
      })
      .catch((e) => setError(e.message));
  }, [token]);
  async function decide(action: string) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/approval/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, comment }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error);
      setData({ ...data, status: result.status });
      setComment("");
      if (action === "comment") {
        const updated = await fetch(`/api/approval/${token}`);
        setData(await updated.json());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save response");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="approval-page">
      <div className="wordmark dark">
        g2a<span> / client review</span>
      </div>
      <section className="panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow">CONTENT APPROVAL</p>
            <h1>{data?.client_name ?? "Client review"}</h1>
          </div>
        </div>
        <div className="dialog-body">
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          {data && (
            <>
              <p className="caption-full">{data.caption}</p>
              <p className="muted">
                {data.scheduled_at
                  ? new Date(data.scheduled_at).toLocaleString("en-GB", {
                      timeZone: data.timezone ?? "Europe/Budapest",
                    })
                  : "Scheduling follows your approval."}
              </p>
              {data.versions?.map((t: any, i: number) => (
                <div className="target-detail" key={i}>
                  <strong>
                    {t.platform} · {t.name}
                  </strong>
                  <p>{t.caption}</p>
                  <div className="approval-media">
                    {t.media.map((m: any) => (
                      <div key={m.id}>
                        {m.mime_type.startsWith("video/") ? (
                          <video src={m.url} controls />
                        ) : (
                          <img src={m.url} alt={m.name} />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {data.comments?.map((c: any, i: number) => (
                <blockquote key={i}>
                  <strong>{c.author}</strong>
                  <p>{c.body}</p>
                </blockquote>
              ))}
              {data.status === "PENDING" ? (
                <>
                  <label>
                    Feedback
                    <textarea
                      rows={4}
                      placeholder="Leave a comment or explain what should change…"
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                    />
                  </label>
                  <div className="button-row">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => void decide("approve")}
                    >
                      Approve post
                    </button>
                    <button
                      disabled={busy || !comment.trim()}
                      onClick={() => void decide("changes")}
                    >
                      Request changes
                    </button>
                    <button
                      disabled={busy || !comment.trim()}
                      onClick={() => void decide("comment")}
                    >
                      Comment
                    </button>
                  </div>
                  <small>
                    This link expires{" "}
                    {new Date(data.expires_at).toLocaleDateString("en-GB", {
                      timeZone: data.timezone ?? "Europe/Budapest",
                    })}
                    .
                  </small>
                </>
              ) : (
                <div className="notice" role="status">
                  Thank you. This review is{" "}
                  {data.status.toLowerCase().replaceAll("_", " ")}.
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
