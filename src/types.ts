export type CriterionOp =
  | 'eq' | 'equal' | 'neq' | 'not_equal'
  | 'lt' | 'less' | 'gt' | 'greater' | 'lte' | 'less_eq' | 'gte' | 'greater_eq'
  | 'between'
  | 'in' | 'nin' | 'not_in'
  | 'exists' | 'nexists' | 'not_exists'
  | 'like' | 'nlike' | 'not_like'
  | 'contains' | 'ncontains' | 'not_contains'
  | 'starts' | 'starts_with' | 'ends' | 'ends_with'
  | 'ilike' | 'not_ilike' | 'icontains' | 'not_icontains' | 'istarts' | 'iends'
  | 'len_eq' | 'len_neq' | 'len_lt' | 'len_gt' | 'len_lte' | 'len_gte' | 'len_between'
  | 'eq_field' | 'neq_field' | 'lt_field' | 'gt_field' | 'lte_field' | 'gte_field'
  | 'regex' | 'not_regex';

export interface Criterion {
  field: string;
  op: CriterionOp;
  value: string;
  value2?: string;
}

export interface CriteriaOr {
  or: CriteriaNode[];
}

export interface CriteriaAnd {
  and: CriteriaNode[];
}

export type CriteriaNode = Criterion | CriteriaOr | CriteriaAnd;

export interface FindQuery {
  mode: 'find';
  dir: string;
  object: string;
  criteria: CriteriaNode[];
  offset?: number;
  limit?: number;
  fields?: string[];
  order_by?: string;
  order?: 'asc' | 'desc';
}

export interface CountQuery {
  mode: 'count';
  dir: string;
  object: string;
  criteria: CriteriaNode[];
}

export interface AggregateSpec {
  fn: 'count' | 'sum' | 'avg' | 'min' | 'max';
  field?: string;
  alias: string;
}

export interface AggregateQuery {
  mode: 'aggregate';
  dir: string;
  object: string;
  criteria?: CriteriaNode[];
  group_by?: string[];
  aggregates: AggregateSpec[];
  having?: CriteriaNode[];
  order_by?: string;
  order?: 'asc' | 'desc';
  limit?: number;
}

export interface DescribeObjectQuery {
  mode: 'describe-object';
  dir: string;
  object: string;
}

export type ReadQuery = FindQuery | CountQuery | AggregateQuery | DescribeObjectQuery;

export interface InsertQuery {
  mode: 'insert';
  dir: string;
  object: string;
  key?: string;
  value: Record<string, unknown>;
  if_not_exists?: boolean;
}

export interface UpdateQuery {
  mode: 'update';
  dir: string;
  object: string;
  key: string;
  value: Record<string, unknown>;
  if?: CriteriaNode[];
}

export interface DeleteQuery {
  mode: 'delete';
  dir: string;
  object: string;
  key: string;
  if?: CriteriaNode[];
}

export type WriteQuery = InsertQuery | UpdateQuery | DeleteQuery;

export type QueryBody = ReadQuery | WriteQuery;

export function isReadQuery(q: QueryBody): q is ReadQuery {
  return q.mode === 'find' || q.mode === 'count' || q.mode === 'aggregate' || q.mode === 'describe-object';
}

export function isWriteQuery(q: QueryBody): q is WriteQuery {
  return q.mode === 'insert' || q.mode === 'update' || q.mode === 'delete';
}

export interface FieldDescriptor {
  name: string;
  type: string;
  size?: number;
  precision?: number;
  scale?: number;
  removed?: boolean;
}

export interface ObjectSchema {
  dir: string;
  object: string;
  splits: number;
  max_key: number;
  max_value: number;
  slot_size: number;
  fields: FieldDescriptor[];
  indexes: string[];
  record_count: number;
}

export type SessionState = string;

export interface QueryRequestItem {
  id: string;
  query: ReadQuery;
}

export type AgentTurnResult =
  | { kind: 'query_request'; queries: QueryRequestItem[]; state: SessionState }
  | { kind: 'answer'; text: string; state: SessionState }
  | { kind: 'proposed_write'; body: WriteQuery; summary: string; pendingId: string; state: SessionState };

export type TurnInput =
  | { kind: 'query_result'; id: string; data: unknown }
  | { kind: 'write_outcome'; pendingId: string; outcome: 'committed' | 'rejected'; error?: string };
