export type Severity = "error" | "warn" | "info";

interface Base {
  file: string;
  line: number;
  /** The source line (trimmed) the claim was extracted from. */
  text: string;
  /** Set when the claim came from --ai extraction. */
  ai?: true;
}

export interface RateLimitClaim extends Base {
  kind: "rate_limit";
  perSecond: number;
}
export interface StatusClaim extends Base {
  kind: "status";
  statuses: number[];
  errorCodes: string[];
}
export interface EndpointClaim extends Base {
  kind: "endpoint";
  method: string;
  path: string;
}
export interface CliCommandClaim extends Base {
  kind: "cli_command";
  tokens: string[];
}
export interface CliFlagClaim extends Base {
  kind: "cli_flag";
  /** Command path from a heading, e.g. ["domains","create"] */
  command: string[];
  flags: string[];
}
export interface CliGroupClaim extends Base {
  kind: "cli_group";
  command: string[];
  subcommands: string[];
}
export interface SdkClaim extends Base {
  kind: "sdk";
  resource: string;
  method: string;
}
export interface DocLinkClaim extends Base {
  kind: "doc_link";
  url: string;
}

export type Claim =
  | RateLimitClaim
  | StatusClaim
  | EndpointClaim
  | CliCommandClaim
  | CliFlagClaim
  | CliGroupClaim
  | SdkClaim
  | DocLinkClaim;

export interface Finding {
  checker: string;
  severity: Severity;
  file: string;
  line: number;
  claim: string;
  message: string;
  expected: string;
  source: string;
  /** Set when the finding comes from a claim only the AI extractor found. */
  ai?: true;
}

export interface CheckerResult {
  checker: string;
  findings: Finding[];
  checked: number;
  skipped?: string;
}
