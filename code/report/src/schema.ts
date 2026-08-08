import { z } from "zod";

export const LEVEL_NAMES = [
  "none",
  "assisted",
  "delegated",
  "automated",
  "governed",
  "self-improving",
] as const;

export const Signals = z.object({
  agents_md: z.boolean(),
  claude_md: z.boolean(),
  dotagents_tree: z.boolean(),
  ci_workflows: z.number().int().min(0),
  agent_workflows: z.array(z.string()),
  docs: z.enum(["none", "thin", "adequate"]),
});

export const BaselineCheck = z.object({
  rule: z.string(),
  status: z.enum(["pass", "fail", "unknown"]),
  note: z.string(),
});

export const RepoReport = z.object({
  name: z.string(),
  visibility: z.string(),
  default_branch: z.string(),
  pushed_at: z.string(),
  active: z.boolean(),
  signals: Signals,
  baseline: z.array(BaselineCheck),
  level: z.number().int().min(0).max(5),
  level_name: z.enum(LEVEL_NAMES),
});

export const OrgReport = z.object({
  org: z.string(),
  scanned_at: z.string(),
  sampling_note: z.string(),
  ranking_note: z.string(),
  repos: z.array(RepoReport),
  org_level: z.number().int().min(0).max(5),
  org_level_name: z.enum(LEVEL_NAMES),
  gaps: z.array(z.string()),
});

export const Report = z.object({
  generated_at: z.string(),
  baseline: z.object({
    name: z.string(),
    enforcement: z.string(),
  }),
  orgs: z.array(OrgReport),
  evidence_limits: z.array(z.string()),
});

export type Report = z.infer<typeof Report>;
export type OrgReport = z.infer<typeof OrgReport>;
export type RepoReport = z.infer<typeof RepoReport>;
export type Signals = z.infer<typeof Signals>;
export type BaselineCheck = z.infer<typeof BaselineCheck>;

// Loose view of an agent-workflow/v1 document, for the web's workflow pages.
// The authoritative validation is spec/agent-workflow.v1.schema.json in CI;
// this schema only shapes what the site renders.
export const WorkflowStep = z
  .object({
    id: z.string().optional(),
    agent: z.string().optional(),
    run: z.string().optional(),
    if: z.string().optional(),
    with: z.record(z.string(), z.unknown()).optional(),
    "posts-to": z.string().optional(),
    "runs-on": z.string().optional(),
    emit: z.record(z.string(), z.unknown()).optional(),
    output: z.unknown().optional(),
    reviewers: z.array(z.string()).optional(),
  })
  .loose();

export const WorkflowDoc = z
  .object({
    kind: z.string(),
    name: z.string(),
    on: z.record(z.string(), z.unknown()),
    steps: z.array(WorkflowStep),
  })
  .loose();

export const WorkflowsFile = z.array(
  z.object({
    file: z.string(),
    raw: z.string(),
    doc: WorkflowDoc,
  }),
);

export type WorkflowsFile = z.infer<typeof WorkflowsFile>;
