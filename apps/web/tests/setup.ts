import { afterEach, vi } from "vitest";

process.env.REDIS_URL ??= "redis://127.0.0.1:6379";
process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@127.0.0.1:5432/spinup_test";
process.env.PROJECT_ARTIFACT_BUCKET ??= "bolt-app-v1";
process.env.AWS_REGION ??= "ap-south-1";
process.env.AWS_AUTH_MODE ??= "auto";
process.env.ASG_NAME ??= "codeserver-autoscaling-group";

const stringStore = new Map<string, string>();
const hashStore = new Map<string, Record<string, string>>();
const setStore = new Map<string, Set<string>>();

const resetRedisState = () => {
  stringStore.clear();
  hashStore.clear();
  setStore.clear();
};

class MockRedis {
  async set(key: string, value: string, ...args: unknown[]) {
    stringStore.set(key, String(value));
    return "OK";
  }

  async get(key: string) {
    return stringStore.get(key) ?? null;
  }

  async del(...keys: string[]) {
    let deleted = 0;

    for (const key of keys) {
      if (stringStore.delete(key)) deleted += 1;
      if (hashStore.delete(key)) deleted += 1;
      if (setStore.delete(key)) deleted += 1;
    }
    return deleted;
  }

  async hset(
    key: string,
    fieldOrObject: Record<string, unknown> | string,
    value?: unknown,
  ) {
    const next = { ...(hashStore.get(key) ?? {}) };

    if (typeof fieldOrObject === "string") {
      next[fieldOrObject] = value === null ? "" : String(value);
    } else {
      for (const [field, fieldValue] of Object.entries(fieldOrObject)) {
        next[field] = fieldValue == null ? "" : String(fieldValue);
      }
    }

    hashStore.set(key, next);
    return Object.keys(next).length;
  }

  async hgetall(key: string) {
    return { ...(hashStore.get(key) ?? {}) };
  }

  async sadd(key: string, ...members: string[]) {
    const current = setStore.get(key) ?? new Set<string>();
    const before = current.size;

    for (const member of members) {
      current.add(String(member));
    }

    setStore.set(key, current);
    return current.size - before;
  }

  async srem(key: string, ...members: string[]) {
    const current = setStore.get(key);
    if (!current) return 0;

    let removed = 0;
    for (const member of members) {
      if (current.delete(String(member))) {
        removed += 1;
      }
    }

    return removed;
  }

  async smembers(key: string) {
    return Array.from(setStore.get(key) ?? new Set<string>());
  }

  async eval(_script: string, _numKeys: number, key: string, token: string) {
    if (stringStore.get(key) === token) {
      stringStore.delete(key);
      return 1;
    }
    return 0;
  }

  multi() {
    const ops: Array<() => Promise<unknown>> = [];

    const pipeline = {
      set: (key: string, value: string, ...args: unknown[]) => {
        ops.push(() => this.set(key, value, ...args));
        return pipeline;
      },
      del: (...keys: string[]) => {
        ops.push(() => this.del(...keys));
        return pipeline;
      },
      hset: (
        key: string,
        fieldOrObject: Record<string, unknown> | string,
        value?: unknown,
      ) => {
        ops.push(() => this.hset(key, fieldOrObject, value));
        return pipeline;
      },
      sadd: (key: string, ...members: string[]) => {
        ops.push(() => this.sadd(key, ...members));
        return pipeline;
      },
      srem: (key: string, ...members: string[]) => {
        ops.push(() => this.srem(key, ...members));
        return pipeline;
      },
      exec: async () => {
        return Promise.all(ops.map((op) => op()));
      },
    };

    return pipeline;
  }
}

vi.mock("ioredis", () => {
  return {
    default: MockRedis,
  };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetRedisState();
});