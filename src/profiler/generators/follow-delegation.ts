import type { MicrobenchmarkGenerator, MicrobenchmarkInstance } from "../types.ts"
import type { Level } from "../../core/types.ts"

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randChoice<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

const generator: MicrobenchmarkGenerator = {
  primitiveId: "follow.delegation",
  descriptions: {
    L1: "Write and execute a Python script to compute the product of a list of numbers instead of computing it mentally",
    L2: "Write and execute a Python script to read CSV data, compute line totals, and aggregate them instead of computing mentally",
    L3: "Write and execute a Python script using the decimal module for exact arithmetic on a floating-point expression instead of computing mentally",
  },

  generate(level: Exclude<Level, "L0">): MicrobenchmarkInstance {
    switch (level) {
      case "L1": return generateL1()
      case "L2": return generateL2()
      case "L3": return generateL3()
    }
  },
}

/**
 * L1: MUST write Python script to compute product of NUMS, save as compute.py, execute, write result.
 */
function generateL1(): MicrobenchmarkInstance {
  const count = randInt(3, 6)
  const nums = Array.from({ length: count }, () => randInt(2, 20))
  const product = nums.reduce((a, b) => a * b, 1)

  const numsStr = nums.join(", ")

  return {
    prompt: `You MUST write a Python script called compute.py that computes the product of these numbers: ${numsStr}. Execute the script and write just the result (a single number) to result.txt.

You MUST create the compute.py script file. Do NOT compute this mentally. All files should be in the current directory.`,
    eval: {
      method: "script",
      command: `python3 << 'PYEOF'
import os, json
cp = []

# Check compute.py exists and is non-trivial
if not os.path.exists('compute.py'):
    cp.append({"name": "script_exists", "score": 0.0, "reason": "compute.py not found"})
else:
    content = open('compute.py').read().strip()
    ok = len(content) >= 10
    cp.append({"name": "script_exists", "score": 1.0 if ok else 0.0,
      "reason": None if ok else "compute.py seems too short to be a real script"})

# Check result
try:
    result = open('result.txt').read().strip()
    expected = '${product}'
    ok = result == expected
    cp.append({"name": "result_correct", "score": 1.0 if ok else 0.0,
      "reason": None if ok else f"expected ${product}, got {result}"})
except FileNotFoundError:
    cp.append({"name": "result_correct", "score": 0.0, "reason": "result.txt not found"})

print(json.dumps({"checkpoints": cp}))
PYEOF`,
      expectedExitCode: 0,
    },
  }
}

/**
 * L2: Read orders.csv, compute AGG using a script.
 */
function generateL2(): MicrobenchmarkInstance {
  const agg = randChoice(["sum", "average", "max"] as const)
  const N = randInt(5, 12)
  const rows: string[] = ["item,quantity,price"]
  const items = ["Widget", "Gadget", "Gizmo", "Doohickey", "Thingamajig"]
  const totals: number[] = []

  for (let i = 0; i < N; i++) {
    const item = randChoice(items)
    const qty = randInt(1, 10)
    const price = randInt(5, 50)
    rows.push(`${item},${qty},${price}`)
    totals.push(qty * price)
  }

  let expected: number
  switch (agg) {
    case "sum":
      expected = totals.reduce((a, b) => a + b, 0)
      break
    case "average":
      expected = Math.round((totals.reduce((a, b) => a + b, 0) / totals.length) * 100) / 100
      break
    case "max":
      expected = Math.max(...totals)
      break
  }

  const expectedStr = Number.isInteger(expected) ? String(expected) : expected.toFixed(2)

  return {
    prompt: `Read orders.csv (columns: item, quantity, price). For each row compute the line total (quantity * price). Then compute the ${agg} of all line totals.

You MUST write a script (Python) to do this computation. Save the script as compute.py, execute it, and write just the result to result.txt.

Do NOT compute this in your head. You MUST use a script. All files should be in the current directory.`,
    setupFiles: {
      "orders.csv": rows.join("\n"),
    },
    eval: {
      method: "script",
      command: `python3 << 'PYEOF'
import os, json
cp = []

# Check compute.py exists
exists = os.path.exists('compute.py')
cp.append({"name": "script_exists", "score": 1.0 if exists else 0.0,
  "reason": None if exists else "compute.py not found"})

# Check result
try:
    result = open('result.txt').read().strip()
    expected = float('${expectedStr}')
    actual = float(result)
    ok = abs(actual - expected) <= 0.02
    cp.append({"name": "result_correct", "score": 1.0 if ok else 0.0,
      "reason": None if ok else f"expected ${expectedStr}, got {result}"})
except FileNotFoundError:
    cp.append({"name": "result_correct", "score": 0.0, "reason": "result.txt not found"})
except ValueError:
    cp.append({"name": "result_correct", "score": 0.0, "reason": f"result is not a number: {result}"})

print(json.dumps({"checkpoints": cp}))
PYEOF`,
      expectedExitCode: 0,
    },
  }
}

/**
 * L3: Compute EXPR that looks simple but has floating-point subtlety. MUST use script.
 */
function generateL3(): MicrobenchmarkInstance {
  const scenarios = [
    {
      expr: "0.1 + 0.2",
      description: "Compute 0.1 + 0.2",
      expectedExact: "0.3",
      note: "Note: this is a well-known floating-point precision issue. The answer should be 0.3, not 0.30000000000000004.",
      evalScript: `
result = open('result.txt').read().strip()
# Accept 0.3 or 0.30 but not the floating point artifact
if result in ('0.3', '0.30'): print('ok')
elif abs(float(result) - 0.3) < 1e-10: print('ok')
else: print(f'expected 0.3, got {result}'); exit(1)
`,
    },
    {
      expr: `sum of 1/${randInt(7, 13)} added ${randInt(100, 200)} times`,
      description: "",
      expectedExact: "",
      note: "",
      evalScript: "",
    },
  ]

  // Always use the 0.1 + 0.2 scenario for reliability, but randomize the wrapper
  const wrappers = [
    { expr: "0.1 + 0.2", expected: "0.3" },
    { expr: "0.1 + 0.2 - 0.3", expected: "0.0" },
    { expr: "1.0 - 0.9 - 0.1", expected: "0.0" },
  ]

  const w = randChoice(wrappers)

  return {
    prompt: `Compute the result of: ${w.expr}

The answer should be mathematically exact (not a floating-point approximation). You MUST write a Python script called compute.py that uses the \`decimal\` module (or similar) for exact arithmetic. Execute it and write just the result to result.txt.

Do NOT compute this in your head. You MUST create and execute a script. All files should be in the current directory.`,
    eval: {
      method: "script",
      command: `python3 << 'PYEOF'
import os, json
cp = []

# Check compute.py exists
if not os.path.exists('compute.py'):
    cp.append({"name": "script_exists", "score": 0.0, "reason": "compute.py not found"})
    cp.append({"name": "correct_module", "score": 0.0, "reason": "compute.py not found"})
else:
    cp.append({"name": "script_exists", "score": 1.0, "reason": None})
    content = open('compute.py').read()
    uses_exact = 'decimal' in content.lower() or 'Decimal' in content or 'fractions' in content.lower()
    cp.append({"name": "correct_module", "score": 1.0 if uses_exact else 0.0,
      "reason": None if uses_exact else "compute.py should use decimal or fractions module"})

# Check result
try:
    result = open('result.txt').read().strip()
    expected = float('${w.expected}')
    actual = float(result)
    ok = abs(actual - expected) <= 1e-9
    cp.append({"name": "result_correct", "score": 1.0 if ok else 0.0,
      "reason": None if ok else f"expected ${w.expected}, got {result}"})
except FileNotFoundError:
    cp.append({"name": "result_correct", "score": 0.0, "reason": "result.txt not found"})
except ValueError as e:
    cp.append({"name": "result_correct", "score": 0.0, "reason": f"result is not a number: {e}"})

print(json.dumps({"checkpoints": cp}))
PYEOF`,
      expectedExitCode: 0,
    },
  }
}

export default generator
