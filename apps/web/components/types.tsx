export type Account = {
  id: string;
  name: string;
  platform: string;
  status: string;
  mode: string;
  token_health: string;
  capabilities: string[];
  last_sync_at: string | null;
};
export type Target = {
  id: string;
  accountId: string;
  platform: string;
  caption: string;
  mediaIds: string[];
  status: string;
  errorCode?: string;
};
export type Post = {
  id: string;
  revision: number;
  approval_kind?: string;
  approval_status?: string;
  approval_expires_at?: string;
  approval_assigned_to?: string;
  approval_reviewer_name?: string;
  approval_reminder_sent_at?: string;
  approval_reminder_count?: number;
  approval_automatic_reminder_count?: number;
  approval_next_reminder_at?: string;
  approval_escalated_at?: string;
  approval_history?: {
    id: string;
    kind: string;
    status: string;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
    reviewerName?: string;
    reminderCount: number;
    automaticReminderCount: number;
    escalatedAt?: string;
  }[];
  author_name?: string;
  caption: string;
  link?: string;
  status: string;
  scheduled_at: string | null;
  created_at: string;
  targets: Target[];
  author_id: string;
};
export type Asset = {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  width?: number;
  height?: number;
  duration_seconds?: number;
  status: string;
};
export type Client = {
  id: string;
  name: string;
  color: string;
  role: string;
  organization_id: string;
};
export type HubData = {
  user: { id: string; name: string; email: string; timezone: string };
  clients: Client[];
  clientId?: string;
  role: string;
  posts: Post[];
  accounts: Account[];
  media: Asset[];
  notifications: { id: string; message: string; created_at: string }[];
  audit: {
    action: string;
    created_at: string;
    resource_id: string;
    metadata: Record<string, unknown>;
  }[];
  brand: Record<string, string>;
  workflow: string[];
  approvalAutomation: {
    automaticReminders: boolean;
    firstReminderHours: number;
    repeatReminderHours: number;
    escalateAfterHours: number;
    maxAutomaticReminders: number;
  };
  reviewers: {
    id: string;
    name: string;
    role: string;
  }[];
  page: number;
  hasMore: boolean;
  mode: string;
  meta: { enabled: boolean };
  operations: {
    publishWaiting: number;
    publishDead: number;
    publishUncertain: number;
    publishReconciliationWaiting: number;
    publishReconciliationUnresolved: number;
    publishReconciliationLastSuccessAt: string | null;
    mediaWaiting: number;
    mediaDead: number;
    oldestDueSeconds: number;
    connectedAccounts: number;
    unhealthyTokens: number;
    approvalDeliveriesWaiting: number;
    approvalDeliveriesFailed: number;
    analyticsWaiting: number;
    analyticsDead: number;
    analyticsLastSuccessAt: string | null;
    worker: {
      healthy: boolean;
      lastSeenAt: string | null;
      revision: string | null;
    };
    needsAttention: boolean;
  } | null;
  privacy: {
    userRequest: PrivacyRequest | null;
    organization: {
      id: string;
      name: string;
      retentionDays: number;
      canDelete: boolean;
      canManageRetention: boolean;
      request: PrivacyRequest | null;
    } | null;
  };
  canManageTeam: boolean;
  team: TeamMember[];
  invitations: TeamInvitation[];
};
export type PrivacyRequest = {
  id: string;
  type: "USER_ERASURE" | "ORGANIZATION_ERASURE";
  status: "PENDING" | "RUNNING" | "FAILED";
  executeAfter: string;
  attempts: number;
  errorCode?: string;
};
export type TeamClient = { id: string; name: string };
export type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: string;
  created_at: string;
  clients: TeamClient[];
};
export type TeamInvitation = {
  id: string;
  email: string;
  role: string;
  status: string;
  expires_at: string;
  created_at: string;
  clients: TeamClient[];
};
export type Mutate = (
  action: string,
  fields?: Record<string, unknown>,
) => Promise<any>;
export const names: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  google: "Google Business",
};
export const initials: Record<string, string> = {
  facebook: "f",
  instagram: "ig",
  linkedin: "in",
  tiktok: "tk",
  google: "G",
};
export const formatDate = (
  value: string | null | undefined,
  timeZone = "Europe/Budapest",
) =>
  value
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone,
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "Not scheduled";
export function Badge({ status }: { status: string }) {
  return (
    <span className={`badge ${status.toLowerCase()}`}>
      {status.toLowerCase().replaceAll("_", " ")}
    </span>
  );
}
export function Network({ platform }: { platform: string }) {
  return (
    <span className={`network ${platform}`} title={names[platform]}>
      {initials[platform] ?? platform.slice(0, 2)}
    </span>
  );
}
