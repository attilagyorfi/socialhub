"use client";
import { useEffect, useState } from "react";
import { Check, Plus, Video } from "lucide-react";
import type { Asset, Mutate } from "./types";

export const MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
];
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

// Signed media URLs expire after five minutes; reuse them for four so lists
// of thumbnails do not request a new signature per render.
const signedUrls = new Map<
  string,
  { at: number; value: Promise<{ url: string; previewUrl: string }> }
>();
export function signedMedia(clientId: string, id: string) {
  const key = `${clientId}:${id}`;
  const cached = signedUrls.get(key);
  if (cached && Date.now() - cached.at < 4 * 60_000) return cached.value;
  const value = fetch(
    `/api/hub?${new URLSearchParams({ clientId, mediaId: id })}`,
  )
    .then((response) => response.json())
    .then((result) => ({
      url: result.url ?? "",
      previewUrl: result.previewUrl ?? "",
    }));
  value.catch(() => signedUrls.delete(key));
  signedUrls.set(key, { at: Date.now(), value });
  return value;
}

function useSignedMedia(clientId: string, id: string) {
  const [media, setMedia] = useState({ url: "", previewUrl: "" });
  useEffect(() => {
    let active = true;
    signedMedia(clientId, id)
      .then((value) => active && setMedia(value))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [clientId, id]);
  return media;
}

// Direct browser upload to private storage, then wait for server-side
// validation. Resolves with the asset id once it is ready.
export function useMediaUpload({
  clientId,
  mutate,
  reload,
  onError,
}: {
  clientId: string;
  mutate: Mutate;
  reload: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  async function upload(file: File) {
    setUploading(true);
    try {
      if (!file.size || file.size > MAX_MEDIA_BYTES)
        throw new Error("Choose a file between 1 byte and 20 MB.");
      if (!MEDIA_TYPES.includes(file.type))
        throw new Error("Upload a PNG, JPEG, WebP image or MP4 video.");
      const prepared = await mutate("media.upload.prepare", {
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
      });
      const uploadResponse = await fetch(prepared.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!uploadResponse.ok)
        throw new Error("The private storage upload failed.");
      await mutate("media.upload.complete", { id: prepared.id });
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        const statusResponse = await fetch(
          `/api/hub?${new URLSearchParams({ clientId })}`,
        );
        const statusData = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(statusData.error);
        const asset = statusData.media.find(
          (candidate: { id: string; status: string }) =>
            candidate.id === prepared.id,
        );
        if (asset?.status === "FAILED")
          throw new Error("The file could not be processed.");
        if (asset?.status === "READY") {
          await reload();
          return prepared.id as string;
        }
      }
      await reload();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }
  return { upload, uploading };
}

export function MediaThumb({
  clientId,
  asset,
}: {
  clientId: string;
  asset: Pick<Asset, "id" | "name" | "mime_type">;
}) {
  const { url, previewUrl } = useSignedMedia(clientId, asset.id);
  const video = asset.mime_type.startsWith("video/");
  const src = previewUrl || (video ? "" : url);
  return (
    <span className="media-thumb">
      {src ? <img src={src} alt="" /> : <span className="media-thumb-empty" />}
      {video && <Video size={14} className="media-thumb-badge" />}
    </span>
  );
}

export function MediaPicker({
  clientId,
  media,
  selected,
  onToggle,
  onUpload,
  uploading = false,
  label,
}: {
  clientId: string;
  media: Asset[];
  selected: string[];
  onToggle: (id: string) => void;
  onUpload?: (file: File) => void;
  uploading?: boolean;
  label: string;
}) {
  const ready = media.filter((m) => m.status === "READY");
  return (
    <div className="media-tiles" role="group" aria-label={label}>
      {onUpload && (
        <label className="media-tile upload-tile">
          <Plus size={20} />
          <span>{uploading ? "Uploading…" : "Upload"}</span>
          <input
            type="file"
            accept={MEDIA_TYPES.join(",")}
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onUpload(file);
              event.target.value = "";
            }}
          />
        </label>
      )}
      {ready.map((asset) => {
        const isSelected = selected.includes(asset.id);
        return (
          <button
            type="button"
            key={asset.id}
            className={`media-tile${isSelected ? " selected" : ""}`}
            aria-pressed={isSelected}
            aria-label={asset.name}
            title={asset.name}
            onClick={() => onToggle(asset.id)}
          >
            <MediaThumb clientId={clientId} asset={asset} />
            {isSelected && (
              <span className="media-tile-check">
                <Check size={14} />
              </span>
            )}
            <small>
              {asset.width ? `${asset.width} × ${asset.height}` : asset.name}
            </small>
          </button>
        );
      })}
    </div>
  );
}

// Instagram feed images must be between 4:5 and 1.91:1; publication frames
// anything outside that range, so the preview shows the same framing.
export function instagramFrame(asset?: Pick<Asset, "width" | "height">) {
  if (!asset?.width || !asset.height) return undefined;
  const ratio = asset.width / asset.height;
  if (ratio < 0.8) return "4 / 5";
  if (ratio > 1.91) return "1.91 / 1";
  return undefined;
}

export function FramedImage({
  clientId,
  asset,
  aspectRatio,
}: {
  clientId: string;
  asset: Pick<Asset, "id" | "name" | "mime_type">;
  aspectRatio: string;
}) {
  const { url } = useSignedMedia(clientId, asset.id);
  if (!url) return <div className="media-placeholder">Media preview</div>;
  return (
    <div className="framed-image" style={{ aspectRatio }}>
      <img src={url} alt="" aria-hidden="true" className="framed-backdrop" />
      <img src={url} alt="Attached media" className="framed-foreground" />
    </div>
  );
}
