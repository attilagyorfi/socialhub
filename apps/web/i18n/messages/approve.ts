// External client approval page (shown in the client's language).
const en = {
  wordmark: " / client review",
  eyebrow: "CONTENT APPROVAL",
  title: "Client review",
  schedulingFollows: "Scheduling follows your approval.",
  feedback: "Feedback",
  placeholder: "Leave a comment or explain what should change…",
  approve: "Approve post",
  requestChanges: "Request changes",
  comment: "Comment",
  expires: "This link expires {date}.",
  thanks: "Thank you. This review is {status}.",
  "status.APPROVED": "approved",
  "status.CHANGES_REQUESTED": "changes requested",
  "status.EXPIRED": "expired",
  "status.SUPERSEDED": "superseded",
  "status.CANCELLED": "cancelled",
  saveFailed: "Unable to save response",
} as const;

const hu = {
  wordmark: " / ügyféloldali jóváhagyás",
  eyebrow: "TARTALOM JÓVÁHAGYÁSA",
  title: "Ügyféloldali jóváhagyás",
  schedulingFollows: "Az ütemezés a jóváhagyásod után történik.",
  feedback: "Visszajelzés",
  placeholder: "Írj megjegyzést, vagy írd le, min kellene változtatni…",
  approve: "Jóváhagyom a posztot",
  requestChanges: "Módosítást kérek",
  comment: "Megjegyzés küldése",
  expires: "A link lejár: {date}.",
  thanks: "Köszönjük! A jóváhagyás állapota: {status}.",
  "status.APPROVED": "jóváhagyva",
  "status.CHANGES_REQUESTED": "módosítást kértél",
  "status.EXPIRED": "lejárt",
  "status.SUPERSEDED": "felülírva",
  "status.CANCELLED": "visszavonva",
  saveFailed: "Nem sikerült elmenteni a válaszodat.",
} satisfies Record<keyof typeof en, string>;

export default { en, hu };
