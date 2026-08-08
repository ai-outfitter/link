// Compile an agent-workflow/v1 document into the process-viewer graph the
// agent-graphs design describes: a signal node, task nodes with process
// facets (decision, review, terminal), declared routes, and data edges.
// The flat step list is the spine; conditional emit steps are route
// terminals hanging off the decision their `if:` reads.

export type Facet = "signal" | "decision" | "review" | "terminal";

export interface GNode {
  id: string;
  kind: "signal" | "agent" | "run" | "emit";
  label: string;
  sub: string[];
  facets: Facet[];
  col: number;
  row: number;
}

export interface GEdge {
  from: string;
  to: string;
  kind: "flow" | "route" | "data";
  label?: string;
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  rows: number;
  cols: number;
}

interface Step {
  id?: string;
  agent?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  "posts-to"?: string;
  "runs-on"?: string;
  emit?: Record<string, unknown>;
  reviewers?: string[];
}

interface Doc {
  name: string;
  on: Record<string, unknown>;
  steps: Step[];
}

const REF = /\$\{\{\s*([a-zA-Z0-9_.\-]+)\s*\}\}/g;
const IF = /steps\.([a-z0-9\-]+)\.output\.([a-z0-9_\-]+)\s*==\s*'([^']*)'/;

function refSteps(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const out: string[] = [];
  for (const m of value.matchAll(REF)) {
    const path = m[1];
    if (path.startsWith("steps.")) out.push(path.split(".")[1]);
    else if (path.startsWith("trigger.")) out.push("trigger");
  }
  return out;
}

function triggerLabel(on: Record<string, unknown>): { label: string; sub: string[] } {
  const [event, rawConfig] = Object.entries(on)[0] ?? ["event", {}];
  const config = (rawConfig ?? {}) as Record<string, unknown>;
  const types = Array.isArray(config.types) ? config.types.join(",") : "";
  const rest = Object.entries(config)
    .filter(([key]) => key !== "types")
    .map(([key, value]) => `${key}: ${value}`);
  return { label: `${event}${types ? ` ${types}` : ""}`, sub: rest };
}

export function buildGraph(doc: Doc): Graph {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];

  const trigger = triggerLabel(doc.on);
  nodes.push({
    id: "trigger",
    kind: "signal",
    label: trigger.label,
    sub: trigger.sub,
    facets: ["signal"],
    col: 0,
    row: 0,
  });

  // Steps another step's `if:` or `runs-on:` reads are decisions.
  const decisionSteps = new Set<string>();
  for (const step of doc.steps) {
    const ifMatch = step.if?.match(IF);
    if (ifMatch) decisionSteps.add(ifMatch[1]);
    for (const source of refSteps(step["runs-on"])) decisionSteps.add(source);
  }

  const stepId = (step: Step, index: number) =>
    step.id ?? `emit-${(step.emit as any)?.status ?? index}`;
  const isBranch = (step: Step) => Boolean(step.if && step.emit && !step.agent && !step.run);

  let spineRow = 0;
  let previousSpine = "trigger";
  const rowsUsed = new Set<string>();

  doc.steps.forEach((step, index) => {
    const id = stepId(step, index);
    const kind = step.agent ? "agent" : step.run ? "run" : "emit";
    const facets: Facet[] = [];
    if (decisionSteps.has(id) || kind === "run") facets.push("decision");
    if (step.agent?.includes("review")) facets.push("review");
    if (step.emit) facets.push("terminal");

    const sub: string[] = [];
    if (step.agent) sub.push(`agent ${step.agent}`);
    if (step.run) sub.push(step.run);
    if (step["posts-to"]) sub.push(`posts-to ${refSteps(step["posts-to"])[0] ?? "forge"}`);
    if (step["runs-on"]) sub.push(`runs-on ← ${refSteps(step["runs-on"])[0] ?? "?"}`);
    if (step.reviewers) sub.push(`reviewers ${step.reviewers.join(", ")}`);
    if (step.emit) sub.push(`emit ${(step.emit as any).status ?? ""}`);

    if (isBranch(step)) {
      const ifMatch = step.if!.match(IF);
      const source = ifMatch?.[1] ?? previousSpine;
      const sourceNode = nodes.find((n) => n.id === source);
      let row = (sourceNode?.row ?? spineRow) + 1;
      while (rowsUsed.has(`1:${row}`)) row += 1;
      rowsUsed.add(`1:${row}`);
      nodes.push({
        id,
        kind: "emit",
        label: `${(step.emit as any)?.status ?? id}`,
        sub: [],
        facets: ["terminal"],
        col: 1,
        row,
      });
      edges.push({ from: source, to: id, kind: "route", label: ifMatch?.[3] ?? step.if });
      return;
    }

    spineRow += 1;
    nodes.push({ id, kind, label: id, sub, facets, col: 0, row: spineRow });
    edges.push({ from: previousSpine, to: id, kind: "flow" });
    previousSpine = id;

    for (const [name, value] of Object.entries(step.with ?? {})) {
      for (const source of refSteps(value)) {
        edges.push({ from: source, to: id, kind: "data", label: name });
      }
    }
    for (const source of refSteps(step["runs-on"])) {
      edges.push({ from: source, to: id, kind: "data", label: "runs-on" });
    }
  });

  // A flow edge leaving a node with declared routes is the remaining route.
  const routed = new Set(edges.filter((e) => e.kind === "route").map((e) => e.from));
  for (const edge of edges) {
    if (edge.kind === "flow" && routed.has(edge.from)) edge.label = "otherwise";
  }

  return {
    nodes,
    edges,
    rows: Math.max(...nodes.map((n) => n.row)) + 1,
    cols: Math.max(...nodes.map((n) => n.col)) + 1,
  };
}
