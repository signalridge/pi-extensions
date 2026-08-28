export const meta = {
  name: "named-task-graph",
  description: "Run independent research and synthesize it through named dependencies",
  phases: [{ title: "research" }, { title: "synthesis" }],
};

const graph = await orchestrate([
  {
    id: "architecture",
    phase: "research",
    description: "Inspect the architecture",
    run: () => agent("Inspect the architecture and report concrete design constraints", { label: "architecture" }),
  },
  {
    id: "risk",
    phase: "research",
    description: "Find operational risks",
    run: () => agent("Find operational and recovery risks", { label: "risk" }),
  },
  {
    id: "synthesis",
    phase: "synthesis",
    dependsOn: ["architecture", "risk"],
    description: "Combine the named findings",
    run: ({ results, statuses }) =>
      agent(
        "Combine these findings. Mention any unavailable dependency explicitly.\n\n" +
          JSON.stringify({ results, statuses }),
        { label: "synthesis" },
      ),
  },
]);

return graph;
