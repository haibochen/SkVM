import type { MicrobenchmarkGenerator, MicrobenchmarkInstance } from "../types.ts"
import type { Level } from "../../core/types.ts"

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randChoice<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

const generator: MicrobenchmarkGenerator = {
  primitiveId: "follow.style",
  descriptions: {
    L1: "Write 2-3 sentences in formal academic tone with no contractions and no first-person pronouns",
    L2: "Explain a scientific concept to a 5-year-old using simple words and enthusiastic tone, avoiding jargon",
    L3: "Write a multi-section document maintaining a specific stylistic register (e.g., pirate, Shakespearean, film noir) consistently throughout every section",
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
 * L1: Write 2-3 sentences about TOPIC in formal academic tone. No contractions, no first person.
 */
function generateL1(): MicrobenchmarkInstance {
  const topics = [
    "climate change",
    "quantum computing",
    "the Industrial Revolution",
    "biodiversity loss",
    "artificial neural networks",
    "the Roman Empire",
  ]

  const topic = randChoice(topics)

  const prompt = `Respond with 2-3 sentences about ${topic} in a formal academic tone. Rules:
- No contractions (don't, can't, it's, etc.)
- No first person pronouns (I, me, my, we, our, etc.)

Provide only the sentences, nothing else.`

  return {
    prompt,
    eval: {
      method: "script",
      command: `python3 << 'PYEOF'
import re, json
text = open('response.txt').read().strip()
cp = []

contractions = re.findall(r"\\b\\w+'\\w+\\b", text)
common_contractions = ["don't", "can't", "won't", "isn't", "aren't", "wasn't", "weren't",
    "it's", "that's", "there's", "here's", "what's", "who's",
    "I'm", "I've", "I'll", "I'd", "we're", "we've", "we'll",
    "they're", "they've", "they'll", "you're", "you've", "you'll",
    "he's", "she's", "couldn't", "wouldn't", "shouldn't", "didn't",
    "hasn't", "haven't", "hadn't"]
found_contractions = [c for c in contractions if c.lower() in common_contractions]
no_contr = len(found_contractions) == 0
cp.append({"name": "no_contractions", "score": 1.0 if no_contr else 0.0,
  "reason": None if no_contr else "contractions found: %s" % found_contractions})

first_person = re.findall(r'\\b(I|me|my|mine|myself|we|us|our|ours|ourselves)\\b', text, re.IGNORECASE)
no_fp = len(first_person) == 0
cp.append({"name": "tone_correct", "score": 1.0 if no_fp else 0.0,
  "reason": None if no_fp else "first person pronouns found: %s" % first_person[:3]})

sentences = [s.strip() for s in re.split(r'[.!?]+', text) if s.strip()]
sent_ok = 2 <= len(sentences) <= 3
cp.append({"name": "word_count", "score": 1.0 if sent_ok else 0.0,
  "reason": None if sent_ok else "expected 2-3 sentences, got %d" % len(sentences)})

print(json.dumps({"checkpoints": cp}))
PYEOF`,
      expectedExitCode: 0,
    },
  }
}

/**
 * L2: Explain CONCEPT to a 5-year-old. Simple words, enthusiastic tone with exclamation marks.
 */
function generateL2(): MicrobenchmarkInstance {
  const concepts = [
    "gravity",
    "photosynthesis",
    "electricity",
    "the water cycle",
    "magnets",
    "the moon",
  ]

  const concept = randChoice(concepts)
  const jargonWords = [
    "therefore", "consequently", "furthermore", "nevertheless", "notwithstanding",
    "paradigm", "methodology", "hypothesis", "synthesize", "extrapolate",
    "aforementioned", "pertaining", "juxtaposition",
  ]

  const jargonJson = JSON.stringify(jargonWords)

  const prompt = `Explain ${concept} to a 5-year-old child. Use simple, everyday words. Be enthusiastic - use exclamation marks! Keep it to 3-4 sentences.

Provide only the explanation, nothing else.`

  return {
    prompt,
    eval: {
      method: "script",
      command: `python3 << 'PYEOF'
import json
text = open('response.txt').read().strip()
cp = []

has_excl = '!' in text
cp.append({"name": "tone_correct", "score": 1.0 if has_excl else 0.0,
  "reason": None if has_excl else "no exclamation marks found (should be enthusiastic)"})

jargon = json.loads('${jargonJson}')
found_jargon = [w for w in jargon if w.lower() in text.lower()]
no_jargon = len(found_jargon) == 0
cp.append({"name": "no_jargon", "score": 1.0 if no_jargon else 0.0,
  "reason": None if no_jargon else f"jargon words found: {found_jargon}"})

word_count = len(text.split())
wc_ok = word_count <= 120
cp.append({"name": "word_count", "score": 1.0 if wc_ok else 0.0,
  "reason": None if wc_ok else f"too long for a 5-year-old explanation: {word_count} words"})

print(json.dumps({"checkpoints": cp}))
PYEOF`,
      expectedExitCode: 0,
    },
  }
}

/**
 * L3: Write S-section document about TOPIC in REGISTER style throughout.
 */
function generateL3(): MicrobenchmarkInstance {
  const scenarios = [
    {
      topic: "coffee",
      sections: 3,
      register: "pirate",
      markers: ["arr", "ye", "matey", "sail", "sea", "treasure", "ship", "ahoy", "plunder", "booty"],
      minMarkers: 2,
    },
    {
      topic: "software testing",
      sections: 3,
      register: "Shakespearean",
      markers: ["thou", "thee", "thy", "hath", "doth", "forsooth", "prithee", "verily", "alas", "hence", "wherefore"],
      minMarkers: 2,
    },
    {
      topic: "exercise",
      sections: 3,
      register: "film noir detective",
      markers: ["dame", "case", "dark", "night", "shadows", "detective", "mystery", "clue", "suspect", "rain", "gumshoe", "broad"],
      minMarkers: 2,
    },
  ]

  const s = randChoice(scenarios)
  const markersJson = JSON.stringify(s.markers)

  const prompt = `Respond with a ${s.sections}-section document about ${s.topic} in the style of a ${s.register}. Each section should have a heading (on its own line, starting with "##") followed by 2-3 sentences. The ${s.register} style must be maintained consistently throughout EVERY section.

Provide only the document, nothing else.`

  return {
    prompt,
    eval: {
      method: "script",
      command: `python3 << 'PYEOF'
import json, re
text = open('response.txt').read().strip()
cp = []

sections = [s.strip() for s in re.split(r'^##', text, flags=re.MULTILINE) if s.strip()]
sec_ok = len(sections) >= ${s.sections}
cp.append({"name": "section_count", "score": 1.0 if sec_ok else 0.0,
  "reason": None if sec_ok else f"expected ${s.sections} sections, got {len(sections)}"})

markers = json.loads('${markersJson}')
found = [m for m in markers if m.lower() in text.lower()]
marker_ok = len(found) >= ${s.minMarkers}
cp.append({"name": "marker_count", "score": 1.0 if marker_ok else 0.0,
  "reason": None if marker_ok else f"too few ${s.register} style markers: found {found}, need >= ${s.minMarkers}"})

if len(sections) >= ${s.sections}:
    consistent = True
    bad_sec = None
    for i, sec in enumerate(sections):
        sec_markers = [m for m in markers if m.lower() in sec.lower()]
        if not sec_markers:
            consistent = False
            bad_sec = i + 1
            break
    cp.append({"name": "style_consistent", "score": 1.0 if consistent else 0.0,
      "reason": None if consistent else f"section {bad_sec} lacks ${s.register} style markers"})

print(json.dumps({"checkpoints": cp}))
PYEOF`,
      expectedExitCode: 0,
    },
  }
}

export default generator
