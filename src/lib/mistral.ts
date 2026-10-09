import { createMistral } from "@ai-sdk/mistral";

/**
 * Mistral can stream a message's `content` as an array that includes parts such as
 * {"type":"reference","reference_ids":[...]}. The AI SDK's response schema only accepts text parts
 * and aborts the whole run with a validation error. Flatten those arrays to plain text (dropping
 * the reference parts) before the SDK sees them.
 */
const flattenContentParts: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!response.body || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return response;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const fixLine = (line: string): string => {
    if (!line.startsWith("data:")) return line;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return line;
    try {
      const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[] };
      let changed = false;
      for (const choice of chunk.choices ?? []) {
        const content = choice.delta?.content;
        if (Array.isArray(content) && choice.delta) {
          choice.delta.content = content
            .map((part: unknown) =>
              typeof part === "string"
                ? part
                : (part as { type?: string; text?: string })?.type === "text"
                  ? ((part as { text?: string }).text ?? "")
                  : "",
            )
            .join("");
          changed = true;
        }
      }
      return changed ? `data: ${JSON.stringify(chunk)}` : line;
    } catch {
      return line;
    }
  };

  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        if (lines.length > 0) controller.enqueue(encoder.encode(`${lines.map(fixLine).join("\n")}\n`));
      },
      flush(controller) {
        if (buffer) controller.enqueue(encoder.encode(fixLine(buffer)));
      },
    }),
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

export const mistral = createMistral({ fetch: flattenContentParts });
