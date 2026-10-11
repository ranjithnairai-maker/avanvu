import { SPORTS } from '@avanvu/core';
const esc = (s: string) => s.replace(/'/g, "''");
const rows = SPORTS.map((s) => `  ('${s.id}', '${s.engine}', '${esc(s.label)}')`).join(',\n');
process.stdout.write(`-- Generated from packages/core/src/sports.ts (CONTRACTS §2). Do not edit by hand:
-- run \`pnpm --filter @avanvu/backend gen:sports\` and commit. A test keeps this file in sync with the registry.
insert into app.sport_engines (id, engine, label) values
${rows}
on conflict (id) do update set engine = excluded.engine, label = excluded.label;
`);
