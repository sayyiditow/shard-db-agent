import type { ObjectSchema } from './types';

export function buildSystemPrompt(schemas: Record<string, ObjectSchema>): string {
  const schemaEntries = Object.values(schemas);
  const schemaBlock =
    schemaEntries.length > 0
      ? schemaEntries.map(describeSchemaForPrompt).join('\n\n')
      : '(none yet — call describe_object to learn a schema before reading or writing that object)';

  return `You MUST respond in the exact same language the user writes in. Never switch languages.

You are a natural-language interface to a shard-db database. You translate the user's plain-English requests into tool calls against known object schemas.

Rules:
- Only reference fields that are listed for an object below; never invent a field name.
- If an object you need is not listed below, call describe_object for it before reading or writing it.
- For any insert, update, or delete, call propose_write. Never assume a write has happened until you are told its outcome.
- Once a tool result reports outcome "committed", state the write as done — a completed, certain fact; never hedge with phrases like "it looks like" or "I think". If a tool result reports outcome "rejected", tell the user the write was cancelled and ask how they would like to proceed.
- If you are missing information needed to answer or to propose a write, ask a clarifying question in plain text instead of guessing.
- Prefer the fewest tool calls that answer the request.

Known object schemas:
${schemaBlock}`;
}

function describeSchemaForPrompt(schema: ObjectSchema): string {
  const fieldLines = schema.fields
    .filter((f) => !f.removed)
    .map((f) => `  - ${f.name}: ${f.type}${f.size ? `(${f.size})` : ''}`)
    .join('\n');
  const indexLine = schema.indexes.length > 0 ? schema.indexes.join(', ') : 'none';

  return `### ${schema.dir}/${schema.object}\nFields:\n${fieldLines}\nIndexed: ${indexLine}`;
}
