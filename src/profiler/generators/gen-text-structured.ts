import type { MicrobenchmarkGenerator, MicrobenchmarkInstance } from "../types.ts"
import type { Level } from "../../core/types.ts"

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randChoice<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

function sample<T>(arr: readonly T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, n)
}

const NAMES = ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Hank"]
const CITIES = ["New York", "London", "Tokyo", "Paris", "Berlin", "Sydney", "Toronto", "Mumbai"]
const COLORS = ["red", "blue", "green", "yellow", "purple", "orange", "black", "white"]
const SKILLS = ["Python", "JavaScript", "SQL", "Docker", "Kubernetes", "React", "Node.js", "TypeScript"]
const DEPTS = ["Engineering", "Marketing", "Sales", "HR", "Finance"]

const generator: MicrobenchmarkGenerator = {
  primitiveId: "gen.text.structured",
  descriptions: {
    L1: "Generate a valid flat JSON object under 500 bytes with specified field names, types, and exact values",
    L2: "Generate a valid nested JSON object under 5KB with arrays, booleans, and nested objects matching a schema",
    L3: "Generate a valid deeply nested JSON object over 5KB representing an organization hierarchy with departments, teams, and members",
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
 * L1: Valid JSON <500B, flat
 * The profiler writes LLM response to response.txt before running eval.
 */
function generateL1(): MicrobenchmarkInstance {
  const name = randChoice(NAMES)
  const age = randInt(18, 67)
  const city = randChoice(CITIES)
  const active = Math.random() > 0.5
  const color = randChoice(COLORS)

  return {
    prompt: `Respond with a JSON object with exactly these fields and values:
- "name": "${name}"
- "age": ${age}
- "city": "${city}"
- "active": ${active}
- "favorite_color": "${color}"

Provide ONLY the JSON object, nothing else.`,
    eval: {
      method: "script",
      command: `python3 << 'PYEOF'
import json, re
text = open('response.txt').read().strip()
bt = chr(96)
text = re.sub(r'^' + bt*3 + r'(?:json)?\\s*', '', text)
text = re.sub(r'\\s*' + bt*3 + r'$', '', text)
cp = []
match = re.search(r'\\{.*\\}', text, re.DOTALL)
cp.append({"name": "json_valid", "score": 1.0 if match else 0.0,
  "reason": None if match else "no JSON found"})
if match:
    try:
        d = json.loads(match.group())
        checks = [
            ("field_name", d.get('name') == '${name}', f"expected ${name}, got {d.get('name')}"),
            ("field_age", d.get('age') == ${age}, f"expected ${age}, got {d.get('age')}"),
            ("field_city", d.get('city') == '${city}', f"expected ${city}, got {d.get('city')}"),
            ("field_active", d.get('active') == ${active ? "True" : "False"}, f"expected ${active}, got {d.get('active')}"),
            ("field_favorite_color", d.get('favorite_color') == '${color}', f"expected ${color}, got {d.get('favorite_color')}"),
        ]
        for cname, ok, reason in checks:
            cp.append({"name": cname, "score": 1.0 if ok else 0.0,
              "reason": None if ok else reason})
    except json.JSONDecodeError as e:
        cp.append({"name": "json_parse", "score": 0.0, "reason": f"invalid JSON: {e}"})
print(json.dumps({"checkpoints": cp}))
PYEOF`,
      expectedExitCode: 0,
    },
  }
}

/**
 * L2: Valid JSON <5KB, nested
 */
function generateL2(): MicrobenchmarkInstance {
  const N = randInt(3, 5)
  const company = randChoice(["Acme Corp", "TechFlow", "DataPrime", "CloudNine"])

  const employees: Array<{
    name: string
    department: string
    skills: string[]
    salary: number
    active: boolean
  }> = []

  for (let i = 0; i < N; i++) {
    employees.push({
      name: NAMES[i]!,
      department: randChoice(DEPTS),
      skills: sample(SKILLS, randInt(2, 4)),
      salary: randInt(40, 120) * 1000,
      active: Math.random() > 0.3,
    })
  }

  const employeeDescriptions = employees.map((e, i) =>
    `  ${i + 1}. name="${e.name}", department="${e.department}", skills=${JSON.stringify(e.skills)}, salary=${e.salary}, active=${e.active}`
  ).join("\n")

  return {
    prompt: `Respond with a JSON object with these exact values:
- "company": "${company}"
- "employee_count": ${N}
- "employees": an array of ${N} employee objects, each with:
${employeeDescriptions}

Each employee object must have: name (string), department (string), skills (array of strings), salary (number), active (boolean).

Provide ONLY the JSON object, nothing else.`,
    eval: {
      method: "script",
      command: `python3 << 'PYEOF'
import json, re
text = open('response.txt').read().strip()
bt = chr(96)
text = re.sub(r'^' + bt*3 + r'(?:json)?\\s*', '', text)
text = re.sub(r'\\s*' + bt*3 + r'$', '', text)
cp = []
try:
    d = json.loads(text)
    cp.append({"name": "json_valid", "score": 1.0, "reason": None})
    co_ok = d.get('company') == '${company}'
    cp.append({"name": "field_company", "score": 1.0 if co_ok else 0.0,
      "reason": None if co_ok else f"expected ${company}, got {d.get('company')}"})
    cnt_ok = d.get('employee_count') == ${N}
    cp.append({"name": "field_employee_count", "score": 1.0 if cnt_ok else 0.0,
      "reason": None if cnt_ok else f"expected ${N}, got {d.get('employee_count')}"})
    emps = d.get('employees', [])
    len_ok = len(emps) == ${N}
    cp.append({"name": "employees_length", "score": 1.0 if len_ok else 0.0,
      "reason": None if len_ok else f"expected ${N} employees, got {len(emps)}"})
    if len_ok:
        types_ok = True
        type_reason = None
        for i, emp in enumerate(emps):
            for k in ['name','department','skills','salary','active']:
                if k not in emp:
                    types_ok, type_reason = False, f"employee {i} missing {k}"
                    break
            if not types_ok:
                break
            if not isinstance(emp['skills'], list):
                types_ok, type_reason = False, f"employee {i} skills not list"
            elif not isinstance(emp['salary'], (int, float)):
                types_ok, type_reason = False, f"employee {i} salary not number"
            elif not isinstance(emp['active'], bool):
                types_ok, type_reason = False, f"employee {i} active not bool"
            if not types_ok:
                break
        cp.append({"name": "type_correct", "score": 1.0 if types_ok else 0.0,
          "reason": type_reason})
except json.JSONDecodeError as e:
    cp.append({"name": "json_valid", "score": 0.0, "reason": f"invalid JSON: {e}"})
print(json.dumps({"checkpoints": cp}))
PYEOF`,
      expectedExitCode: 0,
    },
  }
}

/**
 * L3: Valid JSON >5KB, deeply nested
 */
function generateL3(): MicrobenchmarkInstance {
  const D = randInt(3, 5)
  const T = randInt(2, 4)
  const M = randInt(3, 5)

  return {
    prompt: `Respond with a JSON object representing an organization with this structure:
- "org_name": "GlobalTech"
- "departments": an array of ${D} department objects, each with:
  - "name": a unique department name
  - "head": a person's name
  - "teams": an array of ${T} team objects, each with:
    - "team_name": a unique team name
    - "lead": a person's name
    - "members": an array of ${M} member objects, each with:
      - "name": a person's name
      - "role": a job title
      - "email": an email address
      - "joined_year": a year between 2018-2024

The total output must be valid JSON and larger than 5KB. Provide ONLY the JSON, nothing else.`,
    eval: {
      method: "script",
      command: `python3 << 'PYEOF'
import json, re
text = open('response.txt').read().strip()
bt = chr(96)
text = re.sub(r'^' + bt*3 + r'(?:json)?\\s*', '', text)
text = re.sub(r'\\s*' + bt*3 + r'$', '', text)
cp = []
try:
    d = json.loads(text)
    cp.append({"name": "json_valid", "score": 1.0, "reason": None})
    raw = json.dumps(d)
    size_ok = len(raw) > 5000
    cp.append({"name": "byte_size", "score": 1.0 if size_ok else 0.0,
      "reason": None if size_ok else f"output too small: {len(raw)} bytes"})
    depts = d.get('departments', [])
    dept_ok = len(depts) == ${D}
    cp.append({"name": "field_departments", "score": 1.0 if dept_ok else 0.0,
      "reason": None if dept_ok else f"expected ${D} departments, got {len(depts)}"})
    if dept_ok:
        teams_ok = True
        teams_reason = None
        for dept in depts:
            if len(dept.get('teams', [])) != ${T}:
                teams_ok, teams_reason = False, f"expected ${T} teams, got {len(dept.get('teams', []))}"
                break
        cp.append({"name": "field_teams", "score": 1.0 if teams_ok else 0.0,
          "reason": teams_reason})
        if teams_ok:
            members_ok = True
            members_reason = None
            for dept in depts:
                for team in dept['teams']:
                    if len(team.get('members', [])) != ${M}:
                        members_ok, members_reason = False, f"expected ${M} members, got {len(team.get('members', []))}"
                        break
                    for m in team['members']:
                        for k in ['name','role','email','joined_year']:
                            if k not in m:
                                members_ok, members_reason = False, f"missing member field: {k}"
                                break
                        if not members_ok:
                            break
                    if not members_ok:
                        break
                if not members_ok:
                    break
            cp.append({"name": "type_correct", "score": 1.0 if members_ok else 0.0,
              "reason": members_reason})
except json.JSONDecodeError as e:
    cp.append({"name": "json_valid", "score": 0.0, "reason": f"invalid JSON: {e}"})
print(json.dumps({"checkpoints": cp}))
PYEOF`,
      expectedExitCode: 0,
    },
  }
}

export default generator
