import type { PrimitiveDefinition, PrimitiveId } from "./types.ts"

/**
 * Complete catalog of 26 primitive capabilities from the SkVM paper (supplementary.tex).
 * Each has 3 proficiency levels (L1-L3).
 */
export const PRIMITIVES: PrimitiveDefinition[] = [
  // ---- Generation (9) ----
  {
    id: "gen.code.python",
    category: "generation",
    description: "Python code generation",
    levels: {
      L1: "Single-file script, basic syntax, file I/O",
      L2: "Standard library (csv, json, re, os)",
      L3: "Third-party libs (pandas, requests, numpy)",
    },
    degradations: {
      "L3->L2": "When third-party libraries are needed, provide explicit import statements and basic API call patterns. Avoid method chaining and advanced features — use simple sequential calls.",
      "L2->L1": "Provide explicit file I/O patterns (open/read/write). Avoid standard library modules (csv, json, re) — use string split/strip/replace for parsing.",
    },
  },
  {
    id: "gen.code.javascript",
    category: "generation",
    description: "JavaScript code generation",
    levels: {
      L1: "Single-file script, basic syntax, fs",
      L2: "Node.js built-ins and npm packages",
      L3: "Async/await, complex APIs (DOM, build tools)",
    },
    degradations: {
      "L3->L2": "Replace async/await with callback or synchronous patterns. Avoid complex DOM manipulation and build tool APIs — use simple npm package calls with explicit usage examples.",
      "L2->L1": "Avoid npm packages and Node.js built-ins beyond fs. Use basic file read/write and string operations. Provide explicit code patterns inline.",
    },
  },
  {
    id: "gen.code.shell",
    category: "generation",
    description: "Shell script generation",
    levels: {
      L1: "Basic commands (ls, cat, grep, mkdir)",
      L2: "Pipes, redirection, loops",
      L3: "Complex pipelines (sed, awk, xargs)",
    },
    degradations: {
      "L3->L2": "Replace sed/awk/xargs with explicit loops and simple pipes. Break complex one-liners into multi-step scripts with intermediate variables.",
      "L2->L1": "Avoid pipes, redirection, and loops. Use one command per step and write intermediate results to files.",
    },
  },
  {
    id: "gen.code.sql",
    category: "generation",
    description: "SQL query generation",
    levels: {
      L1: "SELECT, WHERE, basic aggregation",
      L2: "JOINs, GROUP BY, subqueries, windows",
      L3: "CTEs, multi-table, optimization hints",
    },
    degradations: {
      "L3->L2": "Replace CTEs with subqueries or temporary result sets. Avoid optimization hints — use straightforward JOINs and GROUP BY instead.",
      "L2->L1": "Replace JOINs with sequential single-table queries. Avoid subqueries and window functions — compute aggregations in separate queries.",
    },
  },
  {
    id: "gen.code.html",
    category: "generation",
    description: "HTML generation",
    levels: {
      L1: "Headings, lists, links, paragraphs",
      L2: "Forms, tables, semantic HTML, basic SVG",
      L3: "Complex SVG, responsive layouts, a11y",
    },
    degradations: {
      "L3->L2": "Replace complex SVG paths and responsive media queries with simpler table-based layouts and basic SVG shapes. Provide explicit ARIA attributes rather than expecting the model to infer a11y patterns.",
      "L2->L1": "Avoid forms, tables, and SVG. Use only headings, lists, links, and paragraphs. Provide the exact HTML structure to follow.",
    },
  },
  {
    id: "gen.text.structured",
    category: "generation",
    description: "Structured text generation (JSON/YAML)",
    levels: {
      L1: "Valid JSON/YAML <500B, flat",
      L2: "Valid JSON/YAML <5KB, nested",
      L3: "Valid JSON/YAML >5KB, deeply nested",
    },
    degradations: {
      "L3->L2": "Break large structured outputs into smaller chunks (under 5KB each). Reduce nesting depth by flattening intermediate levels.",
      "L2->L1": "Use flat key-value structures only. Avoid nested objects/arrays — represent hierarchies with dot-notation keys or separate flat objects.",
    },
  },
  {
    id: "gen.text.long",
    category: "generation",
    description: "Long text generation",
    levels: {
      L1: "Complete output <1KB",
      L2: "Complete output 1-5KB, maintained structure",
      L3: "Complete output >5KB, delimiters intact",
    },
    degradations: {
      "L3->L2": "Split output into multiple sequential generation steps (each under 5KB). Provide explicit section boundaries and continuation markers.",
      "L2->L1": "Keep each output under 1KB. Break long content into multiple independent pieces rather than one continuous document.",
    },
  },
  {
    id: "gen.text.prose",
    category: "generation",
    description: "Prose writing",
    levels: {
      L1: "Short coherent paragraph",
      L2: "Multi-paragraph, consistent tone",
      L3: "Long-form with sections and transitions",
    },
    degradations: {
      "L3->L2": "Break long-form prose into independent sections with explicit headings. Avoid requiring smooth cross-section transitions — let each section stand alone.",
      "L2->L1": "Reduce to single-paragraph outputs. Provide the exact topic sentence and key points to cover.",
    },
  },
  {
    id: "gen.regex",
    category: "generation",
    description: "Regular expression generation",
    levels: {
      L1: "Literals, character classes, quantifiers",
      L2: "Groups, alternation, anchors",
      L3: "Lookahead/lookbehind, named groups",
    },
    degradations: {
      "L3->L2": "Replace lookahead/lookbehind with multi-step matching: capture broadly first, then filter with a second simpler regex or string check.",
      "L2->L1": "Avoid groups and alternation. Use multiple simple regexes (literals + character classes) applied sequentially instead of one complex pattern.",
    },
  },

  // ---- Reasoning (5) ----
  {
    id: "reason.arithmetic",
    category: "reasoning",
    description: "Arithmetic reasoning",
    levels: {
      L1: "Single-step operations",
      L2: "Multi-step (averages, weighted sums)",
      L3: "Compound (percentage chains, financial)",
    },
    degradations: {
      "L3->L2": "Break compound arithmetic (percentage chains, compound interest) into explicit intermediate steps. Provide formulas and instruct to compute each step separately, storing intermediate results.",
      "L2->L1": "Reduce to single-step operations. Pre-compute intermediate values or instruct the model to delegate multi-step arithmetic to code execution.",
    },
  },
  {
    id: "reason.logic",
    category: "reasoning",
    description: "Logical deduction",
    levels: {
      L1: "Simple if-then deduction",
      L2: "Multi-constraint satisfaction",
      L3: "Optimization under constraints",
    },
    degradations: {
      "L3->L2": "Decompose optimization into explicit constraint-checking steps. Enumerate feasible options then select the best, rather than solving for the optimum directly.",
      "L2->L1": "Reduce to single-constraint deduction. Break multi-constraint problems into a chain of simple if-then checks applied sequentially.",
    },
  },
  {
    id: "reason.spatial",
    category: "reasoning",
    description: "Spatial reasoning",
    levels: {
      L1: "Basic distance and direction (2D)",
      L2: "Geometric calculations (areas, transforms)",
      L3: "Spherical geometry, 3D reasoning",
    },
    degradations: {
      "L3->L2": "Replace spherical/3D calculations with 2D approximations or provide explicit formulas. Instruct the model to delegate complex geometry to code execution.",
      "L2->L1": "Provide explicit formulas for geometric calculations. Reduce to basic distance/direction checks — avoid area computations and coordinate transforms.",
    },
  },
  {
    id: "reason.planning",
    category: "reasoning",
    description: "Task planning",
    levels: {
      L1: "Order 3-5 steps with dependencies",
      L2: "Decompose goals, identify parallelism",
      L3: "Conditional branches, error recovery",
    },
    degradations: {
      "L3->L2": "Replace conditional branches with explicit decision trees. Provide fallback instructions upfront instead of expecting the model to infer error recovery strategies.",
      "L2->L1": "Provide a fixed linear step sequence instead of requiring decomposition. List 3-5 explicit steps with their dependency order.",
    },
  },
  {
    id: "reason.analysis",
    category: "reasoning",
    description: "Code analysis",
    levels: {
      L1: "Identify purpose of short snippet",
      L2: "Find bugs in moderate code",
      L3: "Multi-file root-cause analysis",
    },
    degradations: {
      "L3->L2": "Narrow multi-file analysis to specific files or functions. Provide explicit entry points and call chains to trace instead of requiring the model to discover them.",
      "L2->L1": "Reduce to analyzing short isolated snippets. Provide the relevant code inline rather than requiring the model to locate and cross-reference it.",
    },
  },

  // ---- Tool Use (7) ----
  {
    id: "tool.file.read",
    category: "tool_use",
    description: "File reading",
    levels: {
      L1: "Read a single file by path",
      L2: "Multiple files, handle missing",
      L3: "Large files with offset/pagination",
    },
    degradations: {
      "L3->L2": "Pre-split large files into smaller chunks or provide explicit byte offsets. Avoid requiring the model to paginate autonomously.",
      "L2->L1": "Provide exact file paths upfront. Read one file at a time — avoid multi-file reads and missing-file error handling.",
    },
  },
  {
    id: "tool.file.write",
    category: "tool_use",
    description: "File writing",
    levels: {
      L1: "Write short file (<1KB)",
      L2: "Write larger file (1-10KB)",
      L3: "Write multiple files in sequence",
    },
    degradations: {
      "L3->L2": "Write one file at a time with explicit confirmation between writes. Avoid requiring the model to manage multiple output files in a single pass.",
      "L2->L1": "Keep file content under 1KB. Break larger outputs into smaller files or generate content in chunks with explicit write instructions.",
    },
  },
  {
    id: "tool.exec",
    category: "tool_use",
    description: "Command execution",
    levels: {
      L1: "Run a single command",
      L2: "Write script, execute, save output",
      L3: "Chained multi-step execution",
    },
    degradations: {
      "L3->L2": "Replace chained commands with explicit write-then-execute steps. Run one script at a time, check output before proceeding to the next.",
      "L2->L1": "Provide the exact command to run. Avoid requiring the model to write scripts — use direct single-command invocations.",
    },
  },
  {
    id: "tool.call.format",
    category: "tool_use",
    description: "Tool call formatting",
    levels: {
      L1: "Simple string arguments",
      L2: "Structured arguments (JSON, arrays)",
      L3: "Nested params, special characters",
    },
    degradations: {
      "L3->L2": "Flatten nested parameters into top-level keys. Escape special characters in advance or provide pre-formatted argument strings.",
      "L2->L1": "Reduce to simple string arguments. Convert structured data to flat strings and parse on the other side.",
    },
  },
  {
    id: "tool.call.batch",
    category: "tool_use",
    description: "Batch tool calls",
    levels: {
      L1: "Two parallel reads",
      L2: "Five parallel reads with aggregation",
      L3: "Batch with cross-result reasoning",
    },
    degradations: {
      "L3->L2": "Replace cross-result reasoning with independent per-result processing. Provide explicit aggregation instructions after all results are collected.",
      "L2->L1": "Reduce to two sequential reads instead of parallel batches. Process one file at a time with explicit instructions between reads.",
    },
  },
  {
    id: "tool.web",
    category: "tool_use",
    description: "Web API calls",
    levels: {
      L1: "Simple GET, extract one field",
      L2: "GET with query params, parse response",
      L3: "Multiple APIs, pagination",
    },
    degradations: {
      "L3->L2": "Replace pagination with single-page requests (use higher per_page limits). Call one API at a time instead of coordinating multiple endpoints.",
      "L2->L1": "Provide the exact URL to fetch. Avoid query parameter construction — use pre-built URLs and extract a single field from the response.",
    },
  },
  {
    id: "tool.browser",
    category: "tool_use",
    description: "Browser interaction",
    levels: {
      L1: "Navigate, wait, extract text",
      L2: "Fill forms, click, handle dynamic content",
      L3: "Multi-step workflows with auth",
    },
    degradations: {
      "L3->L2": "Break multi-step workflows into independent single-page actions. Handle auth credentials explicitly upfront rather than expecting the model to manage login flows.",
      "L2->L1": null, // Form filling/clicking cannot be degraded to navigation-only without changing the task — use substitution instead
    },
  },

  // ---- Instruction Following (5) ----
  {
    id: "follow.format",
    category: "instruction_following",
    description: "Output formatting",
    levels: {
      L1: "Output in a named format (JSON)",
      L2: "Conform to specific schema",
      L3: "Multiple format constraints simultaneously",
    },
    degradations: {
      "L3->L2": "Apply one format constraint at a time. Generate in the primary format first, then post-process to satisfy additional format requirements.",
      "L2->L1": "Provide the exact output template with placeholders. Avoid requiring the model to infer schema structure — give a concrete example to fill in.",
    },
  },
  {
    id: "follow.constraint",
    category: "instruction_following",
    description: "Constraint following",
    levels: {
      L1: "Follow a single MUST constraint",
      L2: "Follow 3-5 constraints simultaneously",
      L3: "Constraints conflicting with priors",
    },
    degradations: {
      "L3->L2": "Rephrase constraints that conflict with common model priors into explicit positive instructions. State what TO do instead of what NOT to do.",
      "L2->L1": "Reduce to a single most-critical constraint. Move other constraints into verification steps the model performs after initial output.",
    },
  },
  {
    id: "follow.procedure",
    category: "instruction_following",
    description: "Procedure following",
    levels: {
      L1: "3 sequential steps",
      L2: "5-7 steps with conditional branches",
      L3: "Loops and verification",
    },
    degradations: {
      "L3->L2": "Replace loops with a fixed number of explicit iterations. Provide verification criteria inline rather than requiring the model to determine when to stop.",
      "L2->L1": "Reduce to 3 sequential steps without branches. Replace conditionals with explicit instructions for the most common path.",
    },
  },
  {
    id: "follow.delegation",
    category: "instruction_following",
    description: "Delegation to code",
    levels: {
      L1: "Write and execute a script",
      L2: "Prefer code over mental computation",
      L3: "Consistent delegation when obvious",
    },
    degradations: {
      "L3->L2": "Explicitly mark which computations should be delegated to code. Provide trigger phrases like 'compute this by writing and executing a script' instead of relying on the model to decide when to delegate.",
      "L2->L1": "Provide the exact script template to write and execute. Avoid requiring the model to decide between mental computation and code — always instruct it to use code.",
    },
  },
  {
    id: "follow.style",
    category: "instruction_following",
    description: "Style consistency",
    levels: {
      L1: "Switch formal/casual tone",
      L2: "Specific persona or register",
      L3: "Consistent style across long output",
    },
    degradations: {
      "L3->L2": "Break long output into shorter sections with a style reminder at the start of each. Avoid requiring consistent style across more than 2-3 paragraphs without reinforcement.",
      "L2->L1": "Reduce to simple tone selection (formal or casual). Avoid persona-specific vocabulary — provide explicit word choice examples instead.",
    },
  },
]

// Indexed lookup
const _byId = new Map<string, PrimitiveDefinition>()
for (const p of PRIMITIVES) _byId.set(p.id, p)

export function getPrimitive(id: PrimitiveId): PrimitiveDefinition | undefined {
  return _byId.get(id)
}

export function getAllPrimitives(): PrimitiveDefinition[] {
  return PRIMITIVES
}

export function getPrimitivesByCategory(category: PrimitiveDefinition["category"]): PrimitiveDefinition[] {
  return PRIMITIVES.filter((p) => p.category === category)
}

export const ALL_PRIMITIVE_IDS: string[] = PRIMITIVES.map((p) => p.id)
