import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "../../../../../../packages/server/auth";
export const { GET, POST } = toNextJsHandler(auth);
