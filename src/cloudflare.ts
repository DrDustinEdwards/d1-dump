import { SCRATCH_PREFIX, type Scratch } from "./drill.js";
import type { D1Like, D1Statement } from "./types.js";

// A scratch D1 database reached over Cloudflare's REST API, for a drill run from Node
// or CI where there is no binding. Needs an API token that can create and delete D1
// databases on the account; the token is sent only as the Authorization header and never
// appears in an error.
//
// A BLOB cannot be bound over REST (JSON has no bytes), so a table holding one fails the
// drill with a named error rather than restoring it as a different type.

const API = "https://api.cloudflare.com/client/v4";

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
}

interface Query {
  sql: string;
  params: unknown[];
}

class RestStatement implements D1Statement {
  constructor(
    private readonly run_: (queries: Query[]) => Promise<Array<{ results: unknown[] }>>,
    readonly query: Query
  ) {}
  bind(...values: unknown[]): D1Statement {
    for (const v of values) {
      if (Array.isArray(v)) throw new Error("d1-dump: the REST API cannot bind a BLOB, so a table holding one cannot be drilled over REST");
    }
    return new RestStatement(this.run_, { sql: this.query.sql, params: values });
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const [first] = await this.run_([this.query]);
    return { results: (first?.results ?? []) as T[] };
  }
  async run(): Promise<unknown> {
    return (await this.run_([this.query]))[0];
  }
}

export function cloudflareScratch(accountId: string, apiToken: string, fetchImpl: typeof fetch = fetch): (name: string) => Promise<Scratch> {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetchImpl(`${API}/accounts/${accountId}${path}`, {
      method,
      headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: Envelope<T>;
    try {
      parsed = JSON.parse(text) as Envelope<T>;
    } catch {
      throw new Error(`d1-dump: ${method} ${path} answered ${res.status} with a body that is not JSON`);
    }
    if (!res.ok || !parsed.success) {
      const why = (parsed.errors ?? []).map((e) => e.message ?? String(e.code)).join("; ");
      throw new Error(`d1-dump: ${method} ${path} failed (${res.status}): ${why || "no error given"}`);
    }
    return parsed.result;
  };

  return async (name) => {
    // The one place a database is created or deleted, so nothing else can be touched.
    if (!name.startsWith(SCRATCH_PREFIX)) throw new Error(`d1-dump: refusing to create ${JSON.stringify(name)}: a scratch database starts with ${SCRATCH_PREFIX}`);
    const created = await call<{ uuid: string }>("POST", "/d1/database", { name });
    const id = created.uuid;
    const send = async (queries: Query[]) => {
      const body = queries.length === 1 ? queries[0] : { batch: queries };
      return call<Array<{ results: unknown[] }>>("POST", `/d1/database/${id}/query`, body);
    };
    const db: D1Like = {
      prepare: (sql) => new RestStatement(send, { sql, params: [] }),
      batch: async <T>(statements: D1Statement[]) => {
        const queries = statements.map((s) => (s as RestStatement).query);
        return (await send(queries)) as Array<{ results: T[] }>;
      },
    };
    return { db, delete: async () => void (await call("DELETE", `/d1/database/${id}`)) };
  };
}
