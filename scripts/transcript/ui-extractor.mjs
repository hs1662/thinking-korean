export const PRE_TOOL_USE_UI_TOOLS = new Set([
  "update_steps",
  "ask_question",
  "todo_write",
  "task_create",
  "task_update",
  "update_plan",
]);

const MAX_UNWRAP_DEPTH = 2;

// transcript_full.jsonl stores some tool args as JSON strings; unwrap up to two serialization layers so
// compact transcript.jsonl and transcript_full.jsonl yield the same UI texts.
function unwrapSerialized(value, depth = 0) {
  if (typeof value !== "string" || depth >= MAX_UNWRAP_DEPTH) {
    return value;
  }
  const trimmed = value.trim();
  const first = trimmed.charAt(0);
  if (first !== "[" && first !== "{" && first !== '"') {
    return value;
  }
  try {
    return unwrapSerialized(JSON.parse(trimmed), depth + 1);
  } catch {
    return value;
  }
}

function asObject(value) {
  const unwrapped = unwrapSerialized(value);
  return unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped) ? unwrapped : null;
}

function asArray(value) {
  const unwrapped = unwrapSerialized(value);
  return Array.isArray(unwrapped) ? unwrapped.map((item) => unwrapSerialized(item)) : null;
}

export function extractUiTextsFromToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== "object") {
    return [];
  }
  const name = typeof toolCall.name === "string" ? toolCall.name : "";
  const args = asObject(toolCall.args);
  if (!args) {
    return [];
  }

  const texts = [];
  const pushIfString = (raw) => {
    const val = unwrapSerialized(raw);
    if (typeof val === "string" && val.trim().length > 0) {
      texts.push(val.trim());
    }
  };

  pushIfString(args.toolSummary);
  if (name === "update_steps" || name === "update_plan" || name === "todo_write") {
    const list = asArray(args.steps) ?? asArray(args.todos) ?? asArray(args.plan) ?? [];
    for (const item of list) {
      if (item && typeof item === "object") {
        pushIfString(item.title ?? item.content ?? item.step ?? item.subject);
      }
    }
  } else if (name === "task_create" || name === "task_update") {
    pushIfString(args.subject ?? args.title);
  } else if (name === "ask_question") {
    for (const q of asArray(args.questions) ?? []) {
      if (q && typeof q === "object") {
        pushIfString(q.question);
        for (const opt of asArray(q.options) ?? []) {
          pushIfString(opt);
        }
      }
    }
  } else if (name === "invoke_subagent") {
    pushIfString(args.Role);
  } else if (name === "write_file" || name === "edit_file") {
    const metadata = asObject(args.ArtifactMetadata);
    if (metadata) {
      pushIfString(metadata.Summary);
    }
  } else if (name === "swarm") {
    pushIfString(args.title);
  } else if (name === "run_workflow") {
    pushIfString(args.Description);
  }

  return texts;
}

export function extractUiTextsFromToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return [];
  }
  const texts = [];
  for (const call of toolCalls) {
    texts.push(...extractUiTextsFromToolCall(call));
  }
  return texts;
}
