import type { Tour } from "./logic";

// Tour registry. Targets use `data-tour` attributes placed on hub elements;
// a missing target falls back to a centered step, so tours stay usable when a
// section is hidden for the current user.
export const tours = {
  welcome: {
    id: "welcome",
    version: 1,
    steps: [
      { id: "welcome", title: "tour.welcome.title", body: "tour.welcome.body" },
      {
        id: "client",
        target: '[data-tour="client-switcher"]',
        placement: "bottom",
        title: "tour.client.title",
        body: "tour.client.body",
      },
      {
        id: "navigation",
        target: '[data-tour="navigation"]',
        placement: "right",
        title: "tour.navigation.title",
        body: "tour.navigation.body",
      },
      {
        id: "create",
        target: '[data-tour="create-post"]',
        placement: "bottom",
        title: "tour.create.title",
        body: "tour.create.body",
      },
      {
        id: "calendar",
        target: '[data-tour="nav-calendar"]',
        placement: "right",
        title: "tour.calendar.title",
        body: "tour.calendar.body",
      },
      {
        id: "comments",
        target: '[data-tour="nav-comments"]',
        placement: "right",
        title: "tour.comments.title",
        body: "tour.comments.body",
      },
      {
        id: "help",
        target: '[data-tour="tour-button"]',
        placement: "bottom",
        title: "tour.help.title",
        body: "tour.help.body",
      },
    ],
  },
} satisfies Record<string, Tour>;

export type TourId = keyof typeof tours;
