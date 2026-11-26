import type pg from "pg";
import type { Database } from "@idx-kit/engine/src/db/read.ts";

interface Plan {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: Plan[];
}

export const flatten = (plan: Plan): Plan[] => [
  plan,
  ...(plan.Plans ?? []).flatMap(flatten),
];

export function explainSearch(db: pg.Client) {
  const queries: { sql: string; plan: Plan; ms: number }[] = [];
  const database: Database = {
    async query<T extends pg.QueryResultRow>(sql: string, values: unknown[]) {
      const result = await db.query(
        "EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) " + sql,
        values,
      );
      const explain = result.rows[0]["QUERY PLAN"][0];
      queries.push({
        sql,
        plan: explain.Plan,
        ms: explain["Planning Time"] + explain["Execution Time"],
      });
      return db.query<T>(sql, values);
    },
  };
  return { database, queries };
}

function rowsVisited(scan: Plan) {
  const heap =
    (scan["Actual Rows"] +
      (scan["Rows Removed by Filter"] ?? 0) +
      (scan["Rows Removed by Index Recheck"] ?? 0)) *
    scan["Actual Loops"];
  if (scan["Node Type"] !== "Bitmap Heap Scan") return heap;
  const bitmap = (scan.Plans ?? []).flatMap(flatten).reduce((sum, node) => {
    if (node["Node Type"] !== "Bitmap Index Scan") return sum;
    return sum + node["Actual Rows"] * node["Actual Loops"];
  }, 0);
  return Math.max(heap, bitmap);
}

export function summarizeSearch(
  queries: ReturnType<typeof explainSearch>["queries"],
) {
  const nodes = queries.flatMap(({ plan }) => flatten(plan));
  const scans = nodes.filter((node) =>
    ["listings", "source_mappings"].includes(node["Relation Name"] ?? ""),
  );
  return {
    rows: Math.ceil(scans.reduce((sum, scan) => sum + rowsVisited(scan), 0)),
    listingSeqScan: scans.some(
      (scan) =>
        scan["Relation Name"] === "listings" &&
        scan["Node Type"] === "Seq Scan",
    ),
    ms: queries.reduce((sum, query) => sum + query.ms, 0),
    plan: queries.map(({ plan }) => describePlan(plan)).join("; "),
  };
}

function describePlan(node: Plan): string {
  const scan = node["Index Name"] ?? node["Relation Name"];
  const name = scan ? `${node["Node Type"]} on ${scan}` : node["Node Type"];
  if (!node.Plans) return name;
  return `${name} (${node.Plans.map(describePlan).join(", ")})`;
}
