/* Shape-only runtime for tests that mock runAgent and never make provider calls. */
export const mockParentRuntime = {
  getAuth: async () => { throw new Error("Mock parent runtime cannot authenticate"); },
  getModel: () => { throw new Error("Mock parent runtime cannot resolve models"); },
  stream: () => { throw new Error("Mock parent runtime cannot stream"); },
  streamSimple: () => { throw new Error("Mock parent runtime cannot stream"); },
};

export const mockParentRegistry = { runtime: mockParentRuntime };
