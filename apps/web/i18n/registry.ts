import analytics from "./messages/analytics";
import approve from "./messages/approve";
import auth from "./messages/auth";
import calendar from "./messages/calendar";
import common from "./messages/common";
import compliance from "./messages/compliance";
import composer from "./messages/composer";
import errors from "./messages/errors";
import hub from "./messages/hub";
import legal from "./messages/legal";
import media from "./messages/media";
import posts from "./messages/posts";
import sections from "./messages/sections";
import settings from "./messages/settings";
import team from "./messages/team";

// One namespace per UI area; each file defines English and a Hungarian
// table that the type checker forces to cover every English key.
export const namespaces = {
  analytics,
  approve,
  auth,
  calendar,
  common,
  compliance,
  composer,
  errors,
  hub,
  legal,
  media,
  posts,
  sections,
  settings,
  team,
};
