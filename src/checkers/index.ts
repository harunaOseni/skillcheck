import type { Claim, CheckerResult } from "../types.js";
import type { Sources } from "../sources.js";
import { checkRateLimits } from "./rateLimit.js";
import { checkStatusCodes } from "./statusCodes.js";
import { checkEndpoints } from "./endpoints.js";
import { checkCli } from "./cli.js";
import { checkDocLinks } from "./docLinks.js";

export type Checker = (claims: Claim[], src: Sources) => Promise<CheckerResult>;

export const CHECKERS: Record<string, Checker> = {
  "rate-limits": checkRateLimits,
  "status-codes": checkStatusCodes,
  endpoints: checkEndpoints,
  cli: checkCli,
  "doc-links": checkDocLinks,
};
