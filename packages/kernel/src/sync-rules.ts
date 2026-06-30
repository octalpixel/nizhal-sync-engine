import type {
  Actor,
  BucketColumnRef,
  MembershipQuery,
  Query,
  QueryPredicate,
  SyncRuleDef,
  SyncRules,
} from "./types.js";

type BucketColumns = Record<string, string>;
type BucketRefs<Columns extends BucketColumns> = {
  readonly [Key in keyof Columns & string]: BucketColumnRef<Key>;
};
type BucketValues<Columns extends BucketColumns> = {
  readonly [Key in keyof Columns & string]: unknown;
};

export interface BucketParams<Columns extends BucketColumns> extends Query<keyof Columns & string> {
  readonly bucketColumns: Columns;
}

export interface MembershipParams<Columns extends BucketColumns> extends MembershipQuery<Columns> {}

export interface NizhalDataQuery<BucketKey extends string = string> extends Query<BucketKey> {
  readonly bucketScopes: readonly BucketKey[];
  readonly related?: readonly NizhalDataQuery<BucketKey>[];
}

export interface RawDataQueryOptions<BucketKey extends string> {
  table: string;
  bucketScopes: readonly BucketKey[];
}

class DataQueryBuilder {
  constructor(private readonly table: string) {}

  where<const BucketKey extends string>(
    ...predicates: readonly QueryPredicate<BucketKey>[]
  ): NizhalDataQuery<BucketKey> {
    return {
      kind: "nizhal-query",
      table: this.table,
      predicates,
      bucketScopes: predicates.map((predicate) => predicate.bucket.key),
    };
  }

  related<const BucketKey extends string>(
    related: readonly NizhalDataQuery<BucketKey>[],
    ...predicates: readonly QueryPredicate<BucketKey>[]
  ): NizhalDataQuery<BucketKey> {
    return {
      kind: "nizhal-query",
      table: this.table,
      predicates,
      bucketScopes: predicates.map((predicate) => predicate.bucket.key),
      related,
    };
  }
}

export class SyncRuleBuilder {
  params<const Columns extends BucketColumns>(columns: Columns): BucketParams<Columns> {
    return {
      kind: "nizhal-query",
      table: "__nizhal_bucket_parameters",
      predicates: [],
      bucketColumns: columns,
    };
  }

  membership<const Columns extends BucketColumns>(definition: {
    table: string;
    where: Readonly<Record<string, unknown>>;
    select: Columns;
  }): MembershipParams<Columns> {
    return {
      kind: "echo-membership",
      table: definition.table,
      where: definition.where,
      bucketColumns: definition.select,
    };
  }

  table(table: string): DataQueryBuilder {
    return new DataQueryBuilder(table);
  }

  eq<const BucketKey extends string>(
    column: string,
    bucket: BucketColumnRef<BucketKey>,
  ): QueryPredicate<BucketKey> {
    return { column, operator: "=", bucket };
  }

  raw<const BucketKey extends string>(
    sql: string,
    options: RawDataQueryOptions<BucketKey>,
  ): NizhalDataQuery<BucketKey> {
    return {
      kind: "nizhal-query",
      table: options.table,
      raw: sql,
      predicates: options.bucketScopes.map((key) => ({
        column: key,
        operator: "=",
        bucket: { kind: "bucket-column", key },
      })),
      bucketScopes: options.bucketScopes,
    };
  }

  bucket<const Columns extends BucketColumns>(definition: {
    parameters: (ctx: Actor) => MembershipParams<Columns> | BucketParams<Columns>;
    data: (bucket: BucketRefs<Columns>) => readonly NizhalDataQuery<keyof Columns & string>[];
  }): SyncRuleDef<BucketValues<Columns>> {
    const parameters = definition.parameters({ userId: "", ownerId: "" });
    const bucketColumns = Object.keys(getParameterBucketColumns(parameters));
    return {
      parameters: definition.parameters,
      data: definition.data as SyncRuleDef<BucketValues<Columns>>["data"],
      bucketColumns,
    };
  }
}

export interface SyncRuleLintIssue {
  rule: string;
  queryIndex: number;
  message: string;
}

export class SyncRuleLintError extends Error {
  constructor(readonly issues: readonly SyncRuleLintIssue[]) {
    super(
      `Echo sync-rule no-leak lint failed: ${issues
        .map((issue) => `${issue.rule}.data[${issue.queryIndex}] ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "SyncRuleLintError";
  }
}

export function defineSyncRules<R extends SyncRules>(rules: R): R;
export function defineSyncRules<R extends SyncRules>(factory: (builder: SyncRuleBuilder) => R): R;
export function defineSyncRules<R extends SyncRules>(
  input: R | ((builder: SyncRuleBuilder) => R),
): R {
  const rules = typeof input === "function" ? input(new SyncRuleBuilder()) : input;
  assertSyncRulesNoLeak(rules);
  return rules;
}

export function assertSyncRulesNoLeak(rules: SyncRules): void {
  const issues: SyncRuleLintIssue[] = [];
  for (const [ruleName, rule] of Object.entries(rules)) {
    const bucket = bucketProxy(rule.bucketColumns ?? []);
    const queries = rule.data(bucket);
    queries.forEach((query, queryIndex) => {
      collectQueryLintIssues(issues, ruleName, queryIndex, query, "");
    });
  }
  if (issues.length > 0) throw new SyncRuleLintError(issues);
}

export function collectSyncRuleTables(
  rules: SyncRules,
): Map<string, { table: string; bucketColumns: Set<string> }> {
  assertSyncRulesNoLeak(rules);
  const tables = new Map<string, { table: string; bucketColumns: Set<string> }>();
  for (const rule of Object.values(rules)) {
    for (const query of flattenDataQueries(rule.data(bucketProxy(rule.bucketColumns ?? [])))) {
      const entry = tables.get(query.table) ?? {
        table: query.table,
        bucketColumns: new Set<string>(),
      };
      for (const predicate of query.predicates) entry.bucketColumns.add(predicate.column);
      tables.set(query.table, entry);
    }
  }
  return tables;
}

export function flattenDataQueries(queries: readonly Query[]): Query[] {
  const flattened: Query[] = [];
  for (const query of queries) {
    flattened.push(query);
    if (query.related) flattened.push(...flattenDataQueries(query.related));
  }
  return flattened;
}

function collectQueryLintIssues(
  issues: SyncRuleLintIssue[],
  rule: string,
  queryIndex: number,
  query: Query,
  path: string,
): void {
  if (!isNizhalDataQuery(query)) {
    issues.push({
      rule,
      queryIndex,
      message: `${path}must be built with the Nizhal sync-rule query builder`,
    });
    return;
  }
  if (query.bucketScopes.length === 0) {
    issues.push({
      rule,
      queryIndex,
      message: `${path}must constrain the query by at least one bucket key`,
    });
  }
  if (typeof query.raw === "string") {
    issues.push({
      rule,
      queryIndex,
      message: `${path}must not use raw SQL in sync-rule data queries`,
    });
  }
  query.related?.forEach((related, relatedIndex) => {
    collectQueryLintIssues(issues, rule, queryIndex, related, `related[${relatedIndex}] `);
  });
}

function bucketProxy(keys: readonly string[]): Record<string, BucketColumnRef> {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        if (keys.length > 0 && !keys.includes(property)) {
          throw new Error(`Unknown sync-rule bucket key '${property}'`);
        }
        return { kind: "bucket-column", key: property };
      },
    },
  );
}

function getParameterBucketColumns(parameters: {
  bucketColumns?: BucketColumns;
}): BucketColumns {
  return parameters.bucketColumns ?? {};
}

function isNizhalDataQuery(query: Query): query is NizhalDataQuery {
  return (
    typeof query === "object" &&
    query !== null &&
    (query as NizhalDataQuery).kind === "nizhal-query" &&
    Array.isArray((query as NizhalDataQuery).bucketScopes)
  );
}
