// A small markdown renderer for the note preview: enough of the syntax for
// daily notes, with no dependency and no way to inject markup from the text.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/** safeHref keeps links to the schemes a note may follow. Bare domains take
    an https: `test.com` and `www.test.com/a?b` link without typing it. */
function safeHref(href: string): string | null {
  const url = href.trim();
  if (/^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(url)) return url;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/.test(url)) return `https://${url}`;
  return null;
}

/**
 * inline runs the span level rules over one piece of text. Code spans are
 * lifted out of the escaped text first, so nothing inside them is taken for
 * markup.
 */
function inline(raw: string): string {
  const code: string[] = [];
  let text = escapeHtml(raw).replace(/`([^`\n]+)`/g, (_, body: string) => {
    code.push(`<code>${body}</code>`);
    return `\u0000${code.length - 1}\u0000`;
  });

  text = text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (all, alt: string, src: string) =>
      safeHref(src) ? `<img src="${src}" alt="${alt}" />` : all,
    )
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, label: string, href: string) => {
      const url = safeHref(href);
      return url
        ? `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`
        : all;
    })
    .replace(/\*\*\*([^\n]+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])__([^\n]+?)__(?=$|[\s).,!?:;])/g, "$1<strong>$2</strong>")
    .replace(/\*([^\s*][^\n]*?)\*/g, "<em>$1</em>")
    .replace(/(^|[\s(])_([^\s_][^\n]*?)_(?=$|[\s).,!?:;])/g, "$1<em>$2</em>")
    .replace(/~~([^\n]+?)~~/g, "<del>$1</del>")
    // A line ending in two spaces is an explicit break and eats its newline,
    // so it never doubles with the rule below.
    .replace(/ {2,}(?:\n|$)/g, "<br />");

  // A single newline inside a paragraph breaks too, the way notes read: what
  // was typed on its own line stays on its own line. Code spans hold no
  // newlines, so restoring them first changes nothing here.
  return text
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[+i]!)
    .replace(/\n/g, "<br />");
}

// The block level rules match the text as it was written; every piece they
// hand on goes through inline, which is where escaping happens.
const OPENERS = /^\s*(```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/;

/** renderMarkdown turns note text into the HTML the preview shows. */
export function renderMarkdown(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code, kept verbatim.
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!);
      i++; // the closing fence
      const lang = fence[1]!.trim();
      out.push(
        `<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ""}>${escapeHtml(body.join("\n"))}</code></pre>`,
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
      out.push("<hr />");
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        quote.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      }
      out.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
      continue;
    }

    // Lists, including the - [ ] task form, one list per run of items.
    if (/^\s*([-*+])\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const tag = /^\s*[-*+]\s/.test(line) ? "ul" : "ol";
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
        if (!m) break;
        const task = m[1]!.match(/^\[([ xX])\]\s+(.*)$/);
        items.push(
          task
            ? `<li class="task${task[1]!.toLowerCase() === "x" ? " done" : ""}">` +
              `<span class="box" aria-hidden="true"></span>${inline(task[2]!)}</li>`
            : `<li>${inline(m[1]!)}</li>`,
        );
        i++;
      }
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !OPENERS.test(lines[i]!)) {
      para.push(lines[i++]!);
    }
    if (!para.length) {
      i++; // an opener no rule claimed: never stand still
      continue;
    }
    out.push(`<p>${inline(para.join("\n"))}</p>`);
  }

  return out.join("");
}
