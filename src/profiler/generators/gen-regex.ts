import type { MicrobenchmarkGenerator, MicrobenchmarkInstance } from "../types.ts"
import type { Level } from "../../core/types.ts"

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randChoice<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

const WORDS = [
  "error", "warning", "success", "failure", "timeout",
  "connect", "disconnect", "retry", "abort", "complete",
  "debug", "trace", "critical", "pending", "resolved",
]

const generator: MicrobenchmarkGenerator = {
  primitiveId: "gen.regex",
  descriptions: {
    L1: "Write a regex that matches strings containing a specific word as a substring",
    L2: "Write a regex that validates a structured pattern such as email addresses, dates, or key=value pairs",
    L3: "Write a regex using lookahead or lookbehind assertions for password validation, word boundary detection, or negative pattern exclusion",
  },

  generate(level: Exclude<Level, "L0">): MicrobenchmarkInstance {
    switch (level) {
      case "L1":
        return generateL1()
      case "L2":
        return generateL2()
      case "L3":
        return generateL3()
    }
  },
}

/**
 * L1: Write regex matching strings containing word W (case-sensitive).
 * Eval: apply to test strings, verify matches.
 */
function generateL1(): MicrobenchmarkInstance {
  const W = randChoice(WORDS)
  const N = randInt(8, 15)

  const testStrings: Array<{ text: string; shouldMatch: boolean }> = []

  // Generate strings that should match (contain W exactly)
  const matchCount = randInt(3, Math.min(6, N - 2))
  for (let i = 0; i < matchCount; i++) {
    const prefix = randChoice(["log: ", "msg: ", "event: ", "status: ", ""])
    const suffix = randChoice([" occurred", " detected", " at line " + randInt(1, 100), "", " here"])
    testStrings.push({ text: `${prefix}${W}${suffix}`, shouldMatch: true })
  }

  // Generate strings that should not match
  const nonMatchWords = WORDS.filter((w) => w !== W && !w.includes(W) && !W.includes(w))
  for (let i = 0; i < N - matchCount; i++) {
    const word = randChoice(nonMatchWords)
    const prefix = randChoice(["log: ", "msg: ", "event: ", "status: ", ""])
    testStrings.push({ text: `${prefix}${word} happened`, shouldMatch: false })
  }

  // Shuffle test strings
  testStrings.sort(() => Math.random() - 0.5)

  const testData = JSON.stringify(testStrings)

  return {
    prompt: `Respond with a regular expression that matches strings containing the word "${W}" (case-sensitive, as a substring).

Output ONLY the regex pattern (without delimiters or flags), nothing else.`,
    eval: {
      method: "script",
      command: `python3 << 'PYEOF'
import re, json
cp = []

pattern_text = open('response.txt').read().strip()
# Strip common wrappings
pattern_text = pattern_text.strip('\`').strip('/')
if pattern_text.endswith('/g') or pattern_text.endswith('/i'):
    pattern_text = pattern_text[:-2]
if pattern_text.endswith('/'):
    pattern_text = pattern_text[:-1]
if pattern_text.startswith('/'):
    pattern_text = pattern_text[1:]

try:
    pattern = re.compile(pattern_text)
    cp.append({"name": "regex_valid", "score": 1.0, "reason": None})
except re.error as e:
    cp.append({"name": "regex_valid", "score": 0.0, "reason": f"invalid regex: {e}"})
    print(json.dumps({"checkpoints": cp}))
    raise SystemExit(0)

tests = json.loads('''${testData}''')
for i, t in enumerate(tests):
    matched = bool(pattern.search(t['text']))
    if matched == t['shouldMatch']:
        cp.append({"name": f"case_{i}", "score": 1.0, "reason": None})
    else:
        label = 'false negative' if t['shouldMatch'] else 'false positive'
        cp.append({"name": f"case_{i}", "score": 0.0, "reason": f"{label}: {t['text']}"})

print(json.dumps({"checkpoints": cp}))
PYEOF`,
      expectedExitCode: 0,
    },
  }
}

/**
 * L2: Write regex matching valid PATTERN (email, dates, key=value).
 * Eval: apply to test strings.
 */
function generateL2(): MicrobenchmarkInstance {
  const patternType = randChoice(["email", "date", "key_value"] as const)

  let prompt: string
  let testStrings: Array<{ text: string; shouldMatch: boolean }>

  switch (patternType) {
    case "email": {
      prompt = `Respond with a regular expression that matches valid email addresses. An email has the format: local@domain.tld where:
- local part contains alphanumeric chars, dots, underscores, hyphens
- domain contains alphanumeric chars and hyphens
- tld is 2-6 alphabetic characters

Output ONLY the regex pattern (without delimiters or flags), nothing else.`

      testStrings = [
        { text: "user@example.com", shouldMatch: true },
        { text: "john.doe@company.org", shouldMatch: true },
        { text: "test_user@sub.domain.co", shouldMatch: true },
        { text: "a-b@test.io", shouldMatch: true },
        { text: "name@host.museum", shouldMatch: true },
        { text: "@example.com", shouldMatch: false },
        { text: "user@", shouldMatch: false },
        { text: "user@.com", shouldMatch: false },
        { text: "plaintext", shouldMatch: false },
        { text: "user @example.com", shouldMatch: false },
      ]
      break
    }
    case "date": {
      const format = randChoice(["YYYY-MM-DD", "MM/DD/YYYY"] as const)
      prompt =
        format === "YYYY-MM-DD"
          ? `Respond with a regular expression that matches dates in YYYY-MM-DD format where:
- YYYY is a 4-digit year
- MM is 01-12
- DD is 01-31

Output ONLY the regex pattern (without delimiters or flags), nothing else.`
          : `Respond with a regular expression that matches dates in MM/DD/YYYY format where:
- MM is 01-12
- DD is 01-31
- YYYY is a 4-digit year

Output ONLY the regex pattern (without delimiters or flags), nothing else.`

      testStrings =
        format === "YYYY-MM-DD"
          ? [
              { text: "2024-01-15", shouldMatch: true },
              { text: "2023-12-31", shouldMatch: true },
              { text: "1999-06-01", shouldMatch: true },
              { text: "2024-02-29", shouldMatch: true },
              { text: "24-01-15", shouldMatch: false },
              { text: "2024-13-01", shouldMatch: false },
              { text: "2024-00-15", shouldMatch: false },
              { text: "2024-01-32", shouldMatch: false },
              { text: "2024/01/15", shouldMatch: false },
              { text: "not-a-date", shouldMatch: false },
            ]
          : [
              { text: "01/15/2024", shouldMatch: true },
              { text: "12/31/2023", shouldMatch: true },
              { text: "06/01/1999", shouldMatch: true },
              { text: "02/29/2024", shouldMatch: true },
              { text: "13/01/2024", shouldMatch: false },
              { text: "00/15/2024", shouldMatch: false },
              { text: "01/32/2024", shouldMatch: false },
              { text: "01-15-2024", shouldMatch: false },
              { text: "1/5/2024", shouldMatch: false },
              { text: "not-a-date", shouldMatch: false },
            ]
      break
    }
    case "key_value": {
      prompt = `Respond with a regular expression that matches key=value pairs where:
- key is one or more word characters (letters, digits, underscore)
- followed by = (equals sign)
- value is one or more non-whitespace characters

Output ONLY the regex pattern (without delimiters or flags), nothing else.`

      testStrings = [
        { text: "name=Alice", shouldMatch: true },
        { text: "count=42", shouldMatch: true },
        { text: "path=/usr/bin", shouldMatch: true },
        { text: "debug_mode=true", shouldMatch: true },
        { text: "x=1", shouldMatch: true },
        { text: "=value", shouldMatch: false },
        { text: "key=", shouldMatch: false },
        { text: "no equals here", shouldMatch: false },
        { text: "= =", shouldMatch: false },
      ]
      break
    }
  }

  const testData = JSON.stringify(testStrings)

  return {
    prompt,
    eval: {
      method: "script",
      command: `python3 << 'PYEOF'
import re, json
cp = []

pattern_text = open('response.txt').read().strip()
pattern_text = pattern_text.strip('\`').strip('/')
if pattern_text.endswith('/g') or pattern_text.endswith('/i'):
    pattern_text = pattern_text[:-2]
if pattern_text.endswith('/'):
    pattern_text = pattern_text[:-1]
if pattern_text.startswith('/'):
    pattern_text = pattern_text[1:]

try:
    pattern = re.compile(pattern_text)
    cp.append({"name": "regex_valid", "score": 1.0, "reason": None})
except re.error as e:
    cp.append({"name": "regex_valid", "score": 0.0, "reason": f"invalid regex: {e}"})
    print(json.dumps({"checkpoints": cp}))
    raise SystemExit(0)

tests = json.loads('''${testData}''')
for i, t in enumerate(tests):
    # Use fullmatch for date/email patterns, search for key_value
    matched = bool(pattern.search(t['text']))
    if '${patternType}' in ('email', 'date'):
        # For structured patterns, check if the FULL string matches
        if t['shouldMatch']:
            matched = bool(pattern.search(t['text']))
        else:
            matched = bool(pattern.fullmatch(t['text']))
    if matched == t['shouldMatch']:
        cp.append({"name": f"case_{i}", "score": 1.0, "reason": None})
    else:
        label = 'false negative' if t['shouldMatch'] else 'false positive'
        cp.append({"name": f"case_{i}", "score": 0.0, "reason": f"{label}: {t['text']}"})

print(json.dumps({"checkpoints": cp}))
PYEOF`,
      expectedExitCode: 0,
    },
  }
}

/**
 * L3: Write regex with lookahead/lookbehind assertions.
 * Eval: verify matches and captured groups.
 */
function generateL3(): MicrobenchmarkInstance {
  const variant = randChoice(["password", "word_boundary", "negative_lookahead"] as const)

  let prompt: string
  let testStrings: Array<{ text: string; shouldMatch: boolean }>

  switch (variant) {
    case "password": {
      const minLen = randInt(8, 12)
      prompt = `Respond with a regular expression that validates passwords with these requirements:
- At least ${minLen} characters long
- Contains at least one uppercase letter (use lookahead)
- Contains at least one lowercase letter (use lookahead)
- Contains at least one digit (use lookahead)

The regex must use lookahead assertions. Output ONLY the regex pattern (without delimiters or flags), nothing else.`

      testStrings = [
        { text: "Abcdef1234", shouldMatch: true },
        { text: "MyP4ssword", shouldMatch: true },
        { text: "Str0ngPass!", shouldMatch: true },
        { text: "A".repeat(minLen - 1) + "b1", shouldMatch: true },
        { text: "abcdefgh1", shouldMatch: false },     // no uppercase
        { text: "ABCDEFGH1", shouldMatch: false },     // no lowercase
        { text: "Abcdefghij", shouldMatch: false },    // no digit
        { text: "Ab1", shouldMatch: false },            // too short
        { text: "12345678", shouldMatch: false },       // no letters
      ]
      break
    }
    case "word_boundary": {
      const targetWord = randChoice(["log", "set", "get", "run", "put"])
      prompt = `Respond with a regular expression using a lookbehind and lookahead assertion that matches the word "${targetWord}" ONLY when it appears as a standalone word (not part of a larger word). Use lookahead/lookbehind for word boundary detection (e.g., preceded by non-word char or start, followed by non-word char or end).

Output ONLY the regex pattern (without delimiters or flags), nothing else.`

      testStrings = [
        { text: `the ${targetWord} is here`, shouldMatch: true },
        { text: `${targetWord} starts`, shouldMatch: true },
        { text: `ends with ${targetWord}`, shouldMatch: true },
        { text: targetWord, shouldMatch: true },
        { text: `${targetWord}ger`, shouldMatch: false },
        { text: `b${targetWord}`, shouldMatch: false },
        { text: `${targetWord}ging`, shouldMatch: false },
        { text: `un${targetWord}ted`, shouldMatch: false },
      ]
      break
    }
    case "negative_lookahead": {
      const ext = randChoice([".exe", ".bat", ".sh"])
      prompt = `Respond with a regular expression using a negative lookahead that matches filenames (word characters and dots) that do NOT end with "${ext}". The regex should match the full filename.

A filename consists of one or more word characters, optionally followed by a dot and extension. Use a negative lookahead to exclude files ending with "${ext}".

Output ONLY the regex pattern (without delimiters or flags), nothing else.`

      testStrings = [
        { text: "document.txt", shouldMatch: true },
        { text: "image.png", shouldMatch: true },
        { text: "script.py", shouldMatch: true },
        { text: "readme.md", shouldMatch: true },
        { text: `virus${ext}`, shouldMatch: false },
        { text: `malware${ext}`, shouldMatch: false },
        { text: `script${ext}`, shouldMatch: false },
      ]
      break
    }
  }

  const testData = JSON.stringify(testStrings)

  return {
    prompt,
    eval: {
      method: "script",
      command: `python3 << 'PYEOF'
import re, json
cp = []

pattern_text = open('response.txt').read().strip()
pattern_text = pattern_text.strip('\`').strip('/')
if pattern_text.endswith('/g') or pattern_text.endswith('/i'):
    pattern_text = pattern_text[:-2]
if pattern_text.endswith('/'):
    pattern_text = pattern_text[:-1]
if pattern_text.startswith('/'):
    pattern_text = pattern_text[1:]

try:
    pattern = re.compile(pattern_text)
    cp.append({"name": "regex_valid", "score": 1.0, "reason": None})
except re.error as e:
    cp.append({"name": "regex_valid", "score": 0.0, "reason": f"invalid regex: {e}"})
    print(json.dumps({"checkpoints": cp}))
    raise SystemExit(0)

tests = json.loads('''${testData}''')
for i, t in enumerate(tests):
    if '${variant}' == 'word_boundary':
        matched = bool(pattern.search(t['text']))
    else:
        matched = bool(pattern.fullmatch(t['text']))
    if matched == t['shouldMatch']:
        cp.append({"name": f"case_{i}", "score": 1.0, "reason": None})
    else:
        label = 'false negative' if t['shouldMatch'] else 'false positive'
        cp.append({"name": f"case_{i}", "score": 0.0, "reason": f"{label}: {t['text']}"})

print(json.dumps({"checkpoints": cp}))
PYEOF`,
      expectedExitCode: 0,
    },
  }
}

export default generator
