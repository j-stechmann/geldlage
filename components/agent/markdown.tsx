"use client"

import { Children, memo, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"
import rehypeHighlight from "rehype-highlight"

/**
 * Shared markdown renderer for every chat text (ADR-0033): persisted and
 * streamed assistant content, user bubbles, the Denkprozess trace and tool
 * chip payloads — one component so none of them can drift apart.
 *
 * Styling avoids theme-dependent tokens (bg-muted vs. bg-primary bubbles)
 * by building on `foreground`-opacity and `currentColor`: the same map
 * works on both bubble variants without a variant prop. Raw HTML is
 * ignored by react-markdown's default (safe: no rehype-raw, no sanitizer).
 *
 * remark-breaks preserves the single-newline line breaks the plain-text
 * renderer used to show (chat users type hard breaks, markdown would
 * collapse them). rehype-highlight runs with `detect: false` — only fenced
 * blocks with an explicit language get colored, so streamed German prose
 * and fence-less JSON are never mis-detected and live re-parses stay cheap.
 */

const components: Components = {
  p: (props) => <p {...props} className="my-1.5 first:mt-0 last:mb-0" />,
  ul: (props) => (
    <ul
      {...props}
      className="my-1.5 list-disc pl-5 marker:text-foreground/50 first:mt-0 last:mb-0"
    />
  ),
  ol: (props) => (
    <ol
      {...props}
      className="my-1.5 list-decimal pl-5 marker:text-foreground/50 first:mt-0 last:mb-0"
    />
  ),
  blockquote: (props) => (
    <blockquote
      {...props}
      className="my-1.5 border-l-2 border-foreground/30 pl-2 first:mt-0 last:mb-0"
    />
  ),
  hr: (props) => <hr {...props} className="my-2 border-foreground/20" />,
  /** Fenced source: bg/overflow live on the pre, the code child stays bare. */
  pre: (props) => (
    <pre
      {...props}
      className="my-1.5 overflow-x-auto rounded-lg bg-foreground/10 p-2 font-mono text-xs leading-relaxed first:mt-0 last:mb-0"
    />
  ),
  a: (props) => (
    <a
      {...props}
      title={props.title}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium underline underline-offset-2"
    />
  ),
  table: (props) => (
    <div className="my-1.5 overflow-x-auto">
      <table
        {...props}
        className="w-full border-collapse text-left text-xs [&_td]:border [&_td]:border-foreground/15 [&_td]:px-1.5 [&_td]:py-1 [&_th]:border [&_th]:border-foreground/15 [&_th]:bg-foreground/5 [&_th]:px-1.5 [&_th]:py-1 [&_th]:font-semibold"
      />
    </div>
  ),
  img: (props) => (
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary remote hosts, no next/image optimization in chat bubbles
    <img
      {...props}
      alt={props.alt ?? ""}
      className="my-1.5 max-w-full rounded-lg first:mt-0 last:mb-0"
    />
  ),
}

/**
 * Fenced code carries a `language-*` class (highlighting) — inline code
 * never does; a fence without language is told apart from inline code by
 * its multi-line content (fences are line-oriented). This keeps the pre
 * wrapper free of double backgrounds and the inline chip styling out of
 * fenced blocks.
 */
function isBlockCode(className: string | undefined, children: ReactNode) {
  if (className && /(?:^|\s)language-/.test(className)) return true
  return Children.toArray(children).some(
    (child) => typeof child === "string" && child.includes("\n")
  )
}

export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  return (
    <div
      className={
        "min-w-0 [overflow-wrap:anywhere]" + (className ? ` ${className}` : "")
      }
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        components={{
          ...components,
          code: (props) => (
            <code
              {...props}
              // keep hljs/language-* classes (highlight targeting, semantics)
              className={
                (isBlockCode(props.className, props.children)
                  ? "font-mono text-xs "
                  : "rounded-sm bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em] ") +
                (props.className ?? "")
              }
            />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
