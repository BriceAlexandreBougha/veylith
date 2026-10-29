import assert from "node:assert/strict";
import test from "node:test";

const authState = {
  session: { access_token: "initial-token" },
  refreshSession: { access_token: "refreshed-token" },
  refreshError: null,
  refreshCalls: 0,
};

globalThis.__VEYLITH_TEST_SUPABASE__ = {
  auth: {
    async getSession() {
      return { data: { session: authState.session }, error: null };
    },
    async refreshSession() {
      authState.refreshCalls += 1;
      return {
        data: { session: authState.refreshSession },
        error: authState.refreshError,
      };
    },
  },
};

const { ApiRequestError, apiRequest } = await import("../src/lib/api.ts");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test.beforeEach(() => {
  authState.session = { access_token: "initial-token" };
  authState.refreshSession = { access_token: "refreshed-token" };
  authState.refreshError = null;
  authState.refreshCalls = 0;
});

test("API client sends the bearer token, JSON body and expected route", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return jsonResponse({ saved: true });
  };

  try {
    const result = await apiRequest("/games", {
      method: "POST",
      body: JSON.stringify({ mode: "local" }),
    });

    assert.deepEqual(result, { saved: true });
    assert.equal(captured.url, "http://127.0.0.1:8000/api/games");
    assert.equal(captured.init.headers.get("Authorization"), "Bearer initial-token");
    assert.equal(captured.init.headers.get("Content-Type"), "application/json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API client stops before fetch when there is no session", async () => {
  const originalFetch = globalThis.fetch;
  authState.session = null;
  globalThis.fetch = async () => {
    throw new Error("fetch must not run without a session");
  };

  try {
    await assert.rejects(apiRequest("/games"), /Session expirée/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API client refreshes once after 401 and retries with the new token", async () => {
  const originalFetch = globalThis.fetch;
  const tokens = [];
  globalThis.fetch = async (_url, init) => {
    const token = init.headers.get("Authorization");
    tokens.push(token);
    return token === "Bearer initial-token"
      ? jsonResponse({ detail: "expired" }, 401)
      : jsonResponse({ ok: true });
  };

  try {
    const result = await apiRequest("/games");
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(tokens, ["Bearer initial-token", "Bearer refreshed-token"]);
    assert.equal(authState.refreshCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API client preserves 401 when session refresh fails", async () => {
  const originalFetch = globalThis.fetch;
  authState.refreshError = new Error("refresh failed");
  globalThis.fetch = async () => jsonResponse({ detail: "Jeton invalide" }, 401);

  try {
    await assert.rejects(apiRequest("/games"), (error) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.status, 401);
      assert.equal(error.message, "Jeton invalide");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API client reports non-JSON HTTP errors and handles empty success bodies", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) =>
    init.method === "DELETE"
      ? new Response(null, { status: 204 })
      : new Response("upstream error", { status: 502 });

  try {
    assert.equal(await apiRequest("/games/123", { method: "DELETE" }), undefined);
    await assert.rejects(apiRequest("/games"), (error) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.status, 502);
      assert.equal(error.message, "Erreur HTTP 502");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
